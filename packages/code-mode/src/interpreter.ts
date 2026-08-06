import { parse } from 'acorn';
import {
  DiagnosticCategory,
  ModuleKind,
  ScriptTarget,
  flattenDiagnosticMessageText,
  transpileModule,
} from 'typescript';
import {
  DEFAULT_CODE_MODE_LIMITS,
  type CodeModeDiagnosticKind,
  type CodeModeExecutionResult,
  type CodeModeLimits,
  type CodeModeToolCall,
  type ExecuteCodeCellInput,
  serializedByteLength,
} from './index.js';

interface AstNode {
  type: string;
  loc?: {
    start: { line: number; column: number };
  } | null;
  [key: string]: unknown;
}

class InterpreterError extends Error {
  constructor(
    readonly kind: CodeModeDiagnosticKind,
    message: string,
    readonly node?: AstNode,
  ) {
    super(message);
    this.name = 'InterpreterError';
  }
}

class ReturnSignal {
  constructor(readonly value: unknown) {}
}

class BreakSignal {}
class ContinueSignal {}

class Environment {
  private readonly values = new Map<string, { value: unknown; constant: boolean }>();

  constructor(private readonly parent?: Environment) {}

  declare(name: string, value: unknown, constant: boolean): void {
    if (this.values.has(name)) {
      throw new InterpreterError('execution_error', `Identifier "${name}" is already declared`);
    }
    this.values.set(name, { value, constant });
  }

  get(name: string, node: AstNode): unknown {
    if (this.values.has(name)) return this.values.get(name)?.value;
    if (this.parent) return this.parent.get(name, node);
    throw new InterpreterError('execution_error', `Unknown identifier "${name}"`, node);
  }

  set(name: string, value: unknown, node: AstNode): unknown {
    const binding = this.values.get(name);
    if (binding) {
      if (binding.constant) {
        throw new InterpreterError('execution_error', `Cannot assign to constant "${name}"`, node);
      }
      binding.value = value;
      return value;
    }
    if (this.parent) return this.parent.set(name, value, node);
    throw new InterpreterError('execution_error', `Unknown identifier "${name}"`, node);
  }
}

class ToolReference {
  constructor(readonly name: string) {}
}

class PromiseMethodReference {
  constructor(readonly name: 'all' | 'allSettled' | 'resolve' | 'reject') {}
}

class CellPromise {
  private observed = false;

  constructor(readonly promise: Promise<unknown>) {
    promise.catch(() => {});
  }

  observe(): Promise<unknown> {
    this.observed = true;
    return this.promise;
  }

  isObserved(): boolean {
    return this.observed;
  }
}

class CellFunction {
  constructor(
    readonly parameters: readonly AstNode[],
    readonly body: AstNode,
    readonly expressionBody: boolean,
    readonly closure: Environment,
  ) {}
}

class ArrayMethodReference {
  constructor(
    readonly target: unknown[],
    readonly name: 'map' | 'filter' | 'push' | 'sort' | 'join' | 'includes' | 'slice',
  ) {}
}

class StringMethodReference {
  constructor(
    readonly target: string,
    readonly name:
      | 'trim'
      | 'toLowerCase'
      | 'toUpperCase'
      | 'includes'
      | 'startsWith'
      | 'endsWith'
      | 'slice'
      | 'substring'
      | 'split',
  ) {}
}

class DataMethodReference {
  constructor(
    readonly root: 'JSON' | 'Object',
    readonly name: string,
  ) {}
}

const TOOL_ROOT = Symbol('tools');
const PROMISE_ROOT = Symbol('Promise');
const JSON_ROOT = Symbol('JSON');
const OBJECT_ROOT = Symbol('Object');
const OPTIONAL_CHAIN_SHORT_CIRCUIT = Symbol('optional-chain-short-circuit');
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MEMBER_ROOT_BINDINGS = new Set(['tools', 'Promise', 'JSON', 'Object']);
const RESERVED_ROOT_BINDINGS = new Set([...MEMBER_ROOT_BINDINGS, 'undefined']);
const SUPPORTED_SYNTAX_NODES = new Set([
  'Program',
  'BlockStatement',
  'VariableDeclaration',
  'VariableDeclarator',
  'ReturnStatement',
  'ExpressionStatement',
  'IfStatement',
  'ForOfStatement',
  'ForStatement',
  'WhileStatement',
  'DoWhileStatement',
  'TryStatement',
  'CatchClause',
  'ThrowStatement',
  'BreakStatement',
  'ContinueStatement',
  'EmptyStatement',
  'Literal',
  'Identifier',
  'ArrowFunctionExpression',
  'AwaitExpression',
  'ChainExpression',
  'ObjectExpression',
  'ArrayExpression',
  'MemberExpression',
  'CallExpression',
  'BinaryExpression',
  'LogicalExpression',
  'ConditionalExpression',
  'UnaryExpression',
  'AssignmentExpression',
  'UpdateExpression',
  'TemplateLiteral',
  'TemplateElement',
  'Property',
  'SpreadElement',
  'AssignmentPattern',
  'ArrayPattern',
  'ObjectPattern',
  'RestElement',
]);
const SUPPORTED_BINARY_OPERATORS = new Set([
  '===',
  '!==',
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  '+',
  '-',
  '*',
  '/',
  '%',
]);
const SUPPORTED_LOGICAL_OPERATORS = new Set(['&&', '||', '??']);
const SUPPORTED_UNARY_OPERATORS = new Set(['!', '+', '-', 'typeof', 'void']);
const SUPPORTED_ASSIGNMENT_OPERATORS = new Set(['=', '+=', '-=', '*=', '/=', '%=']);
const SUPPORTED_UPDATE_OPERATORS = new Set(['++', '--']);
const SUPPORTED_PROMISE_METHODS = new Set(['all', 'allSettled', 'resolve', 'reject']);
const SUPPORTED_DATA_METHODS = new Set([
  'parse',
  'stringify',
  'keys',
  'values',
  'entries',
  'fromEntries',
]);
const SUPPORTED_COLLECTION_METHODS = new Set([
  'map',
  'filter',
  'push',
  'sort',
  'join',
  'includes',
  'slice',
  'trim',
  'toLowerCase',
  'toUpperCase',
  'startsWith',
  'endsWith',
  'split',
  'substring',
]);

interface CopyBudget {
  nodes: number;
  maxNodes: number;
}

const MAX_COPY_NODES = 100_000;

class Interpreter {
  private readonly limits: CodeModeLimits;
  private readonly startedAt = Date.now();
  private readonly toolNames: Set<string>;
  private readonly toolCalls: CodeModeToolCall[] = [];
  private readonly cellAbortController = new AbortController();
  private readonly ownedPromises: CellPromise[] = [];
  private readonly hostToolOperations: Promise<unknown>[] = [];
  private readonly wallTimeTimer: ReturnType<typeof setTimeout>;
  private readonly forwardInputAbort: () => void;
  private terminalFailure: { reason: unknown } | undefined;
  private steps = 0;
  private activeToolCalls = 0;

  constructor(private readonly input: ExecuteCodeCellInput) {
    this.limits = { ...DEFAULT_CODE_MODE_LIMITS, ...input.limits };
    this.toolNames = new Set(input.tools.map((tool) => tool.name));
    this.forwardInputAbort = () => {
      if (!this.cellAbortController.signal.aborted) {
        this.cellAbortController.abort(input.signal ? abortReason(input.signal) : undefined);
      }
    };
    if (input.signal?.aborted) this.forwardInputAbort();
    else input.signal?.addEventListener('abort', this.forwardInputAbort, { once: true });
    this.wallTimeTimer = setTimeout(() => {
      if (!this.cellAbortController.signal.aborted) {
        this.cellAbortController.abort(
          new InterpreterError('limit_exceeded', 'Cell wall-time limit exceeded'),
        );
      }
    }, this.limits.maxWallTimeMs);
  }

  async execute(program: AstNode): Promise<CodeModeExecutionResult> {
    const environment = new Environment();
    environment.declare('tools', TOOL_ROOT, true);
    environment.declare('Promise', PROMISE_ROOT, true);
    environment.declare('JSON', JSON_ROOT, true);
    environment.declare('Object', OBJECT_ROOT, true);
    environment.declare('undefined', undefined, true);
    try {
      let value: unknown = null;
      try {
        await this.evaluateStatements(nodes(program, 'body'), environment);
      } catch (signal) {
        if (!(signal instanceof ReturnSignal)) throw signal;
        value = await resolveCellValue(signal.value);
      }
      this.throwIfTerminalFailure();
      await this.superviseUnobservedPromises();
      this.throwIfTerminalFailure();
      const copied = copyPlainData(
        value,
        'execution result',
        this.limits.maxDataDepth,
        0,
        new Set(),
        this.limits.maxCollectionItems,
      );
      assertByteLimit(copied, this.limits.maxOutputBytes, 'output');
      return { ok: true, value: copied, toolCalls: [...this.toolCalls] };
    } catch (error) {
      if (!this.cellAbortController.signal.aborted) this.cellAbortController.abort(error);
      const drained = await Promise.allSettled([
        ...this.ownedPromises.map((promise) => promise.promise),
        ...this.hostToolOperations,
      ]);
      if (this.input.signal?.aborted) throw abortReason(this.input.signal);
      if (this.input.isFatalToolError?.(error)) throw error;
      const fatalDrain = drained.find(
        (settled) => settled.status === 'rejected' && this.input.isFatalToolError?.(settled.reason),
      );
      if (fatalDrain?.status === 'rejected') throw fatalDrain.reason;
      const normalized = normalizeError(error);
      return { ok: false, error: normalized, toolCalls: [...this.toolCalls] };
    } finally {
      clearTimeout(this.wallTimeTimer);
      this.input.signal?.removeEventListener('abort', this.forwardInputAbort);
    }
  }

  private async superviseUnobservedPromises(): Promise<void> {
    for (;;) {
      const unobserved = this.ownedPromises.filter((promise) => !promise.isObserved());
      if (unobserved.length === 0) return;
      await Promise.all(unobserved.map((promise) => promise.observe()));
    }
  }

  private ownPromise(promise: Promise<unknown>): CellPromise {
    const owned = new CellPromise(promise);
    this.ownedPromises.push(owned);
    return owned;
  }

  private throwIfTerminalFailure(): void {
    if (this.input.signal?.aborted) throw abortReason(this.input.signal);
    if (this.cellAbortController.signal.aborted) {
      throw abortReason(this.cellAbortController.signal);
    }
    if (this.terminalFailure) throw this.terminalFailure.reason;
  }

  private async evaluateStatements(
    statements: readonly AstNode[],
    env: Environment,
  ): Promise<void> {
    for (const statement of statements) await this.evaluateStatement(statement, env);
  }

  private async evaluateStatement(node: AstNode, env: Environment): Promise<void> {
    await this.tick(node);
    switch (node.type) {
      case 'VariableDeclaration': {
        const constant = field(node, 'kind') === 'const';
        for (const declaration of nodes(node, 'declarations')) {
          const id = ast(declaration, 'id');
          const init = optionalAst(declaration, 'init');
          await this.declarePattern(
            id,
            init ? await resolveCellValue(await this.evaluateExpression(init, env)) : undefined,
            env,
            constant,
          );
        }
        return;
      }
      case 'ReturnStatement': {
        const argument = optionalAst(node, 'argument');
        throw new ReturnSignal(argument ? await this.evaluateExpression(argument, env) : null);
      }
      case 'ExpressionStatement':
        await this.evaluateExpression(ast(node, 'expression'), env);
        return;
      case 'BlockStatement':
        await this.evaluateStatements(nodes(node, 'body'), new Environment(env));
        return;
      case 'IfStatement': {
        const branch = (await this.evaluateExpression(ast(node, 'test'), env))
          ? ast(node, 'consequent')
          : optionalAst(node, 'alternate');
        if (branch) await this.evaluateStatement(branch, env);
        return;
      }
      case 'ForOfStatement': {
        if (field(node, 'await') === true) {
          throw unsupported(node, 'for await is not supported');
        }
        const iterable = await resolveCellValue(
          await this.evaluateExpression(ast(node, 'right'), env),
        );
        let values: readonly unknown[] | string | undefined;
        if (Array.isArray(iterable)) {
          this.assertCollectionSize(iterable.length, 'for...of', node);
          values = iterable;
        } else if (typeof iterable === 'string') {
          let itemCount = 0;
          for (const _character of iterable) {
            itemCount += 1;
            this.assertCollectionSize(itemCount, 'for...of', node);
          }
          values = iterable;
        }
        if (values === undefined) {
          throw new InterpreterError(
            'execution_error',
            'for...of expects an array or string',
            node,
          );
        }
        const left = ast(node, 'left');
        for (const value of values) {
          await this.tick(node);
          const iterationEnv = new Environment(env);
          if (left.type === 'VariableDeclaration') {
            const declarations = nodes(left, 'declarations');
            if (declarations.length !== 1) {
              throw unsupported(left, 'for...of requires one variable declaration');
            }
            await this.declarePattern(
              ast(declarations[0] as AstNode, 'id'),
              value,
              iterationEnv,
              field(left, 'kind') === 'const',
            );
          } else {
            this.assignPattern(left, value, env);
          }
          try {
            await this.evaluateStatement(ast(node, 'body'), iterationEnv);
          } catch (signal) {
            if (signal instanceof ContinueSignal) continue;
            if (signal instanceof BreakSignal) break;
            throw signal;
          }
        }
        return;
      }
      case 'ForStatement': {
        const loopEnv = new Environment(env);
        const init = optionalAst(node, 'init');
        if (init) {
          if (init.type === 'VariableDeclaration') await this.evaluateStatement(init, loopEnv);
          else await this.evaluateExpression(init, loopEnv);
        }
        for (;;) {
          await this.tick(node);
          const test = optionalAst(node, 'test');
          if (test && !(await this.evaluateExpression(test, loopEnv))) break;
          const action = await this.evaluateLoopBody(ast(node, 'body'), loopEnv);
          if (action === 'break') break;
          const update = optionalAst(node, 'update');
          if (update) await this.evaluateExpression(update, loopEnv);
        }
        return;
      }
      case 'WhileStatement':
      case 'DoWhileStatement': {
        let first = true;
        for (;;) {
          await this.tick(node);
          if (
            (!first || node.type === 'WhileStatement') &&
            !(await this.evaluateExpression(ast(node, 'test'), env))
          ) {
            break;
          }
          first = false;
          if ((await this.evaluateLoopBody(ast(node, 'body'), env)) === 'break') break;
        }
        return;
      }
      case 'TryStatement': {
        try {
          await this.evaluateStatement(ast(node, 'block'), env);
        } catch (error) {
          if (
            error instanceof ReturnSignal ||
            error instanceof BreakSignal ||
            error instanceof ContinueSignal
          ) {
            throw error;
          }
          const handler = optionalAst(node, 'handler');
          if (!handler) throw error;
          const catchEnv = new Environment(env);
          const parameter = optionalAst(handler, 'param');
          if (parameter) {
            await this.declarePattern(parameter, caughtReason(error), catchEnv, false);
          }
          await this.evaluateStatement(ast(handler, 'body'), catchEnv);
        } finally {
          const finalizer = optionalAst(node, 'finalizer');
          if (finalizer) await this.evaluateStatement(finalizer, env);
        }
        return;
      }
      case 'ThrowStatement':
        throw await resolveCellValue(await this.evaluateExpression(ast(node, 'argument'), env));
      case 'BreakStatement':
        throw new BreakSignal();
      case 'ContinueStatement':
        throw new ContinueSignal();
      case 'EmptyStatement':
        return;
      default:
        throw unsupported(node, `Unsupported statement: ${node.type}`);
    }
  }

  private async evaluateExpression(node: AstNode, env: Environment): Promise<unknown> {
    await this.tick(node);
    switch (node.type) {
      case 'Literal':
        return field(node, 'value');
      case 'Identifier':
        return env.get(stringField(node, 'name'), node);
      case 'ArrowFunctionExpression':
        return new CellFunction(
          nodes(node, 'params'),
          ast(node, 'body'),
          field(node, 'expression') === true,
          env,
        );
      case 'AwaitExpression':
        return await resolveCellValue(await this.evaluateExpression(ast(node, 'argument'), env));
      case 'ChainExpression': {
        const value = await this.evaluateExpression(ast(node, 'expression'), env);
        return value === OPTIONAL_CHAIN_SHORT_CIRCUIT ? undefined : value;
      }
      case 'ObjectExpression': {
        const output: Record<string, unknown> = {};
        let outputItems = 0;
        for (const property of nodes(node, 'properties')) {
          if (property.type === 'SpreadElement') {
            const spread = await resolveCellValue(
              await this.evaluateExpression(ast(property, 'argument'), env),
            );
            if (!isPlainRecord(spread)) {
              throw new InterpreterError(
                'invalid_data',
                'Object spread expects plain data',
                property,
              );
            }
            const spreadEntries = Object.entries(spread);
            let spreadItems = 0;
            for (const [key] of spreadEntries) {
              assertSafeKey(key, property);
              if (!Object.hasOwn(output, key)) spreadItems += 1;
            }
            this.assertCollectionSize(outputItems + spreadItems, 'object spread', node);
            for (const [key, value] of spreadEntries) {
              output[key] = value;
            }
            outputItems += spreadItems;
            continue;
          }
          if (property.type !== 'Property' || field(property, 'kind') !== 'init') {
            throw unsupported(property, 'Only ordinary object properties are supported');
          }
          const key = propertyName(property, env, this);
          assertSafeKey(key, property);
          const isNewKey = !Object.hasOwn(output, key);
          if (isNewKey) this.assertCollectionSize(outputItems + 1, 'object literal', node);
          output[key] = await this.evaluateExpression(ast(property, 'value'), env);
          if (isNewKey) outputItems += 1;
        }
        return output;
      }
      case 'ArrayExpression': {
        const output: unknown[] = [];
        for (const element of arrayField(node, 'elements')) {
          if (element === null) {
            this.assertCollectionSize(output.length + 1, 'array literal', node);
            output.push(null);
          } else {
            const elementNode = asAst(element, node);
            if (elementNode.type === 'SpreadElement') {
              const spread = await resolveCellValue(
                await this.evaluateExpression(ast(elementNode, 'argument'), env),
              );
              if (!Array.isArray(spread) && typeof spread !== 'string') {
                throw new InterpreterError(
                  'invalid_data',
                  'Array spread expects an array or string',
                  elementNode,
                );
              }
              if (Array.isArray(spread)) {
                this.assertCollectionSize(output.length + spread.length, 'array spread', node);
              } else {
                let spreadItems = 0;
                for (const _item of spread) {
                  spreadItems += 1;
                  this.assertCollectionSize(output.length + spreadItems, 'array spread', node);
                }
              }
              output.push(...spread);
            } else {
              output.push(await this.evaluateExpression(elementNode, env));
              this.assertCollectionSize(output.length, 'array literal', node);
            }
          }
        }
        return output;
      }
      case 'MemberExpression': {
        const object = await resolveCellValue(
          await this.evaluateExpression(ast(node, 'object'), env),
        );
        if (object === OPTIONAL_CHAIN_SHORT_CIRCUIT) return OPTIONAL_CHAIN_SHORT_CIRCUIT;
        if (field(node, 'optional') === true && (object === null || object === undefined)) {
          return OPTIONAL_CHAIN_SHORT_CIRCUIT;
        }
        const property = await this.memberName(node, env);
        assertSafeKey(property, node);
        if (object === TOOL_ROOT) {
          if (!this.toolNames.has(property)) {
            throw new InterpreterError(
              'unknown_tool',
              `Unknown or inactive tool "${property}"`,
              node,
            );
          }
          return new ToolReference(property);
        }
        if (object === PROMISE_ROOT) {
          if (property === 'race') {
            throw unsupported(
              node,
              'Promise.race is not supported because nested tool calls cannot escape a cell',
            );
          }
          if (!['all', 'allSettled', 'resolve', 'reject'].includes(property)) {
            throw new InterpreterError(
              'execution_error',
              `Unsupported Promise method "${property}"`,
              node,
            );
          }
          return new PromiseMethodReference(property as PromiseMethodReference['name']);
        }
        if (object === JSON_ROOT && ['parse', 'stringify'].includes(property)) {
          return new DataMethodReference('JSON', property);
        }
        if (
          object === OBJECT_ROOT &&
          ['keys', 'values', 'entries', 'fromEntries'].includes(property)
        ) {
          return new DataMethodReference('Object', property);
        }
        if (
          Array.isArray(object) &&
          ['map', 'filter', 'push', 'sort', 'join', 'includes', 'slice'].includes(property)
        ) {
          return new ArrayMethodReference(object, property as ArrayMethodReference['name']);
        }
        if (typeof object === 'string') {
          if (property === 'length') return object.length;
          const index = stringIndex(property);
          if (index !== undefined) return object[index];
          if (
            [
              'trim',
              'toLowerCase',
              'toUpperCase',
              'includes',
              'startsWith',
              'endsWith',
              'slice',
              'substring',
              'split',
            ].includes(property)
          ) {
            return new StringMethodReference(object, property as StringMethodReference['name']);
          }
        }
        if ((Array.isArray(object) || isPlainRecord(object)) && Object.hasOwn(object, property)) {
          return object[property as keyof typeof object];
        }
        if (object === null || object === undefined) {
          throw new InterpreterError('execution_error', `Cannot read property "${property}"`, node);
        }
        return undefined;
      }
      case 'CallExpression': {
        const callee = await this.evaluateExpression(ast(node, 'callee'), env);
        if (callee === OPTIONAL_CHAIN_SHORT_CIRCUIT) return OPTIONAL_CHAIN_SHORT_CIRCUIT;
        if (field(node, 'optional') === true && (callee === null || callee === undefined)) {
          return OPTIONAL_CHAIN_SHORT_CIRCUIT;
        }
        if (callee instanceof DataMethodReference) {
          return this.callDataMethod(callee, await this.evaluateCallArguments(node, env), node);
        }
        if (callee instanceof StringMethodReference) {
          return this.callStringMethod(callee, await this.evaluateCallArguments(node, env), node);
        }
        if (callee instanceof PromiseMethodReference) {
          const args = nodes(node, 'arguments');
          if (args.length !== 1 || args[0]?.type === 'SpreadElement') {
            throw new InterpreterError(
              'execution_error',
              `Promise.${callee.name} expects one argument`,
              node,
            );
          }
          const argument = await this.evaluateExpression(args[0], env);
          return this.callPromiseMethod(callee.name, argument, node);
        }
        if (callee instanceof ArrayMethodReference) {
          const args = nodes(node, 'arguments');
          if (args.some((argument) => argument.type === 'SpreadElement')) {
            throw new InterpreterError(
              'execution_error',
              `Array.${callee.name} does not accept spread arguments`,
              node,
            );
          }
          if (callee.name === 'push') {
            const values = [];
            for (const argument of args) {
              values.push(await this.evaluateExpression(argument, env));
            }
            this.assertCollectionSize(callee.target.length + values.length, 'Array.push', node);
            callee.target.push(...values);
            return callee.target.length;
          }
          if (callee.name === 'sort') {
            if (args.length !== 0) {
              throw unsupported(node, 'Array.sort comparators are not supported');
            }
            this.sortUtf16Values(callee.target, node);
            return callee.target;
          }
          if (callee.name === 'join') {
            if (args.length > 1) {
              throw new InterpreterError(
                'execution_error',
                'Array.join expects zero or one argument',
                node,
              );
            }
            const separatorValue = args[0]
              ? await resolveCellValue(await this.evaluateExpression(args[0], env))
              : undefined;
            const separator =
              separatorValue === undefined
                ? ','
                : this.coerceToIntermediateString(separatorValue, 'Array.join separator', node);
            this.assertJoinedString(callee.target, separator, 'Array.join', node);
            return callee.target.join(separator);
          }
          if (callee.name === 'includes') {
            if (args.length !== 1) {
              throw new InterpreterError(
                'execution_error',
                'Array.includes expects one argument',
                node,
              );
            }
            return callee.target.includes(
              await resolveCellValue(await this.evaluateExpression(args[0] as AstNode, env)),
            );
          }
          if (callee.name === 'slice') {
            if (args.length > 2) {
              throw new InterpreterError(
                'execution_error',
                'Array.slice expects at most two arguments',
                node,
              );
            }
            const values = await this.evaluateCallArguments(node, env);
            const start = values[0] === undefined ? 0 : Number(values[0]);
            const end = values[1] === undefined ? callee.target.length : Number(values[1]);
            const normalizedStart = Math.max(
              0,
              Math.min(callee.target.length, start < 0 ? callee.target.length + start : start),
            );
            const normalizedEnd = Math.max(
              normalizedStart,
              Math.min(callee.target.length, end < 0 ? callee.target.length + end : end),
            );
            this.assertCollectionSize(normalizedEnd - normalizedStart, 'Array.slice', node);
            return callee.target.slice(
              values[0] === undefined ? undefined : start,
              values[1] === undefined ? undefined : end,
            );
          }
          if (args.length !== 1) {
            throw new InterpreterError(
              'execution_error',
              `Array.${callee.name} expects one callback`,
              node,
            );
          }
          const callback = await this.evaluateExpression(args[0], env);
          if (!(callback instanceof CellFunction)) {
            throw new InterpreterError(
              'execution_error',
              `Array.${callee.name} expects a function`,
              node,
            );
          }
          return this.callArrayMethod(callee, callback, node);
        }
        if (!(callee instanceof ToolReference)) {
          throw unsupported(node, 'Only calls to tools.* are supported in this expression');
        }
        const args = nodes(node, 'arguments');
        if (args.length > 1 || args.some((argument) => argument.type === 'SpreadElement')) {
          throw new InterpreterError(
            'execution_error',
            'Tool calls accept one argument object',
            node,
          );
        }
        const argument = args[0] ? await this.evaluateExpression(args[0], env) : {};
        return this.ownPromise(this.callTool(callee.name, argument, node));
      }
      case 'BinaryExpression':
        return this.evaluateBinary(
          stringField(node, 'operator'),
          await this.evaluateExpression(ast(node, 'left'), env),
          await this.evaluateExpression(ast(node, 'right'), env),
          node,
        );
      case 'LogicalExpression': {
        const operator = stringField(node, 'operator');
        const left = await this.evaluateExpression(ast(node, 'left'), env);
        if (operator === '&&') {
          return left ? this.evaluateExpression(ast(node, 'right'), env) : left;
        }
        if (operator === '||') {
          return left ? left : this.evaluateExpression(ast(node, 'right'), env);
        }
        if (operator === '??') {
          return left !== null && left !== undefined
            ? left
            : this.evaluateExpression(ast(node, 'right'), env);
        }
        throw unsupported(node, `Unsupported logical operator: ${operator}`);
      }
      case 'ConditionalExpression':
        return (await this.evaluateExpression(ast(node, 'test'), env))
          ? this.evaluateExpression(ast(node, 'consequent'), env)
          : this.evaluateExpression(ast(node, 'alternate'), env);
      case 'UnaryExpression':
        return this.evaluateUnary(
          stringField(node, 'operator'),
          await this.evaluateExpression(ast(node, 'argument'), env),
          node,
        );
      case 'AssignmentExpression': {
        const operator = stringField(node, 'operator');
        const left = ast(node, 'left');
        const right = await this.evaluateExpression(ast(node, 'right'), env);
        if (operator === '=') return this.assignPattern(left, right, env);
        if (left.type !== 'Identifier') {
          throw unsupported(left, 'Compound assignment requires an identifier');
        }
        const current = env.get(stringField(left, 'name'), left);
        const next = this.evaluateBinary(operator.slice(0, -1), current, right, node);
        return env.set(stringField(left, 'name'), next, left);
      }
      case 'UpdateExpression': {
        const argument = ast(node, 'argument');
        if (argument.type !== 'Identifier') {
          throw unsupported(argument, 'Update expressions require an identifier');
        }
        const name = stringField(argument, 'name');
        const current = env.get(name, argument);
        if (typeof current !== 'number') {
          throw new InterpreterError(
            'execution_error',
            'Update expressions require a number',
            node,
          );
        }
        const operator = stringField(node, 'operator');
        const next = operator === '++' ? current + 1 : operator === '--' ? current - 1 : undefined;
        if (next === undefined) throw unsupported(node, `Unsupported update operator: ${operator}`);
        env.set(name, next, argument);
        return field(node, 'prefix') === true ? next : current;
      }
      case 'TemplateLiteral': {
        const quasis = nodes(node, 'quasis');
        const expressions = nodes(node, 'expressions');
        let output = '';
        for (let index = 0; index < quasis.length; index += 1) {
          const value = field(quasis[index] as AstNode, 'value');
          output = this.concatenateStrings(
            output,
            isPlainRecord(value) && typeof value.cooked === 'string' ? value.cooked : '',
            node,
          );
          if (expressions[index]) {
            output = this.concatenateStrings(
              output,
              this.coerceToIntermediateString(
                await resolveCellValue(await this.evaluateExpression(expressions[index], env)),
                'Template interpolation',
                node,
              ),
              node,
            );
          }
        }
        return output;
      }
      default:
        throw unsupported(node, `Unsupported expression: ${node.type}`);
    }
  }

  private async declarePattern(
    pattern: AstNode,
    value: unknown,
    env: Environment,
    constant: boolean,
  ): Promise<void> {
    if (pattern.type === 'Identifier') {
      env.declare(stringField(pattern, 'name'), value, constant);
      return;
    }
    if (pattern.type === 'AssignmentPattern') {
      const selected =
        value === undefined ? await this.evaluateExpression(ast(pattern, 'right'), env) : value;
      await this.declarePattern(ast(pattern, 'left'), selected, env, constant);
      return;
    }
    if (pattern.type === 'ArrayPattern') {
      if (!Array.isArray(value)) {
        throw new InterpreterError(
          'execution_error',
          'Array destructuring expects an array',
          pattern,
        );
      }
      let index = 0;
      for (const item of arrayField(pattern, 'elements')) {
        if (item === null) {
          index += 1;
          continue;
        }
        const child = asAst(item, pattern);
        if (child.type === 'RestElement') {
          await this.declarePattern(ast(child, 'argument'), value.slice(index), env, constant);
          index = value.length;
          continue;
        }
        await this.declarePattern(child, value[index], env, constant);
        index += 1;
      }
      return;
    }
    if (pattern.type === 'ObjectPattern') {
      if (!isPlainRecord(value)) {
        throw new InterpreterError(
          'execution_error',
          'Object destructuring expects plain data',
          pattern,
        );
      }
      const consumed = new Set<string>();
      for (const property of nodes(pattern, 'properties')) {
        if (property.type === 'RestElement') {
          const rest: Record<string, unknown> = {};
          for (const [key, item] of Object.entries(value)) {
            if (!consumed.has(key)) rest[key] = item;
          }
          await this.declarePattern(ast(property, 'argument'), rest, env, constant);
          continue;
        }
        if (property.type !== 'Property' || field(property, 'kind') !== 'init') {
          throw unsupported(property, 'Unsupported object destructuring property');
        }
        const key = propertyName(property, env, this);
        assertSafeKey(key, property);
        consumed.add(key);
        await this.declarePattern(ast(property, 'value'), value[key], env, constant);
      }
      return;
    }
    throw unsupported(pattern, `Unsupported binding pattern: ${pattern.type}`);
  }

  private async evaluateLoopBody(
    body: AstNode,
    env: Environment,
  ): Promise<'continue' | 'break' | 'complete'> {
    try {
      await this.evaluateStatement(body, env);
      return 'complete';
    } catch (signal) {
      if (signal instanceof ContinueSignal) return 'continue';
      if (signal instanceof BreakSignal) return 'break';
      throw signal;
    }
  }

  private assignPattern(pattern: AstNode, value: unknown, env: Environment): unknown {
    if (pattern.type === 'Identifier') {
      return env.set(stringField(pattern, 'name'), value, pattern);
    }
    throw unsupported(pattern, 'Only identifier assignment targets are supported');
  }

  private async memberName(node: AstNode, env: Environment): Promise<string> {
    const property = ast(node, 'property');
    if (field(node, 'computed') === true) {
      const value = await this.evaluateExpression(property, env);
      if (typeof value !== 'string' && typeof value !== 'number') {
        throw new InterpreterError(
          'execution_error',
          'Computed property must be a string or number',
          node,
        );
      }
      return String(value);
    }
    if (property.type !== 'Identifier') throw unsupported(property, 'Invalid member property');
    return stringField(property, 'name');
  }

  private async evaluateCallArguments(node: AstNode, env: Environment): Promise<unknown[]> {
    const values: unknown[] = [];
    for (const argument of nodes(node, 'arguments')) {
      if (argument.type === 'SpreadElement') {
        throw unsupported(argument, 'Spread call arguments are not supported');
      }
      values.push(await resolveCellValue(await this.evaluateExpression(argument, env)));
    }
    return values;
  }

  private callDataMethod(
    method: DataMethodReference,
    args: readonly unknown[],
    node: AstNode,
  ): unknown {
    if (method.root === 'JSON') {
      if (method.name === 'parse') {
        if (args.length !== 1 || typeof args[0] !== 'string') {
          throw new InterpreterError('execution_error', 'JSON.parse expects one string', node);
        }
        try {
          return copyPlainData(
            JSON.parse(args[0]),
            'JSON.parse result',
            this.limits.maxDataDepth,
            0,
            new Set(),
            this.limits.maxCollectionItems,
          );
        } catch (error) {
          if (error instanceof InterpreterError) throw error;
          throw new InterpreterError(
            'execution_error',
            `JSON.parse failed: ${error instanceof Error ? error.message : String(error)}`,
            node,
          );
        }
      }
      if (args.length !== 1) {
        throw new InterpreterError('execution_error', 'JSON.stringify expects one value', node);
      }
      const copied = copyPlainData(
        args[0],
        'JSON.stringify input',
        this.limits.maxDataDepth,
        0,
        new Set(),
        this.limits.maxCollectionItems,
        true,
      );
      assertByteLimit(copied, this.limits.maxIntermediateBytes, 'JSON.stringify');
      return JSON.stringify(copied);
    }

    if (method.name === 'fromEntries') {
      if (args.length !== 1 || !Array.isArray(args[0])) {
        throw new InterpreterError('execution_error', 'Object.fromEntries expects one array', node);
      }
      this.assertCollectionSize(args[0].length, 'Object.fromEntries', node);
      const output: Record<string, unknown> = {};
      let uniqueKeyCount = 0;
      let processedEntryCount = 0;
      for (const entry of args[0]) {
        if (!Array.isArray(entry) || entry.length < 2) {
          throw new InterpreterError(
            'execution_error',
            'Object.fromEntries expects key/value pairs',
            node,
          );
        }
        const key = this.coerceToIntermediateString(entry[0], 'Object.fromEntries key', node);
        assertSafeKey(key, node);
        if (!Object.hasOwn(output, key)) uniqueKeyCount += 1;
        this.assertCollectionSize(uniqueKeyCount, 'Object.fromEntries', node);
        processedEntryCount += 1;
        if ((processedEntryCount & 0xff) === 0) this.checkWallTime(node);
        output[key] = entry[1];
      }
      return output;
    }
    if (args.length !== 1 || (!Array.isArray(args[0]) && !isPlainRecord(args[0]))) {
      throw new InterpreterError(
        'execution_error',
        `Object.${method.name} expects plain data`,
        node,
      );
    }
    const itemCount = Array.isArray(args[0]) ? args[0].length : Object.keys(args[0]).length;
    this.assertCollectionSize(itemCount, `Object.${method.name}`, node);
    if (method.name === 'keys') return Object.keys(args[0]);
    if (method.name === 'values') return Object.values(args[0]);
    return Object.entries(args[0]);
  }

  private callStringMethod(
    method: StringMethodReference,
    args: readonly unknown[],
    node: AstNode,
  ): unknown {
    const noArgs = (): void => {
      if (args.length !== 0) {
        throw new InterpreterError(
          'execution_error',
          `String.${method.name} expects no arguments`,
          node,
        );
      }
    };
    switch (method.name) {
      case 'trim':
        noArgs();
        return method.target.trim();
      case 'toLowerCase':
        noArgs();
        return method.target.toLowerCase();
      case 'toUpperCase':
        noArgs();
        return method.target.toUpperCase();
      case 'includes':
      case 'startsWith':
      case 'endsWith': {
        if (args.length < 1 || args.length > 2) {
          throw new InterpreterError(
            'execution_error',
            `String.${method.name} expects one or two arguments`,
            node,
          );
        }
        const search = this.coerceToIntermediateString(
          args[0],
          `String.${method.name} search`,
          node,
        );
        const position = args[1] === undefined ? undefined : Number(args[1]);
        return method.target[method.name](search, position);
      }
      case 'slice':
      case 'substring': {
        if (args.length > 2) {
          throw new InterpreterError(
            'execution_error',
            `String.${method.name} expects at most two arguments`,
            node,
          );
        }
        if (args.length === 0) return method.target[method.name](0);
        return method.target[method.name](
          Number(args[0]),
          args[1] === undefined ? undefined : Number(args[1]),
        );
      }
      case 'split':
        if (args.length > 2) {
          throw new InterpreterError(
            'execution_error',
            'String.split expects at most two arguments',
            node,
          );
        }
        if (args.length === 0) {
          this.assertCollectionSize(1, 'String.split', node);
          return [method.target];
        }
        if (args[0] instanceof RegExp) {
          throw unsupported(node, 'String.split does not support regular expression separators');
        }
        const requestedLimit = args[1] === undefined ? undefined : Number(args[1]);
        if (args[0] === undefined) {
          const itemCount = normalizeStringSplitLimit(requestedLimit) === 0 ? 0 : 1;
          this.assertCollectionSize(itemCount, 'String.split', node);
          return itemCount === 0 ? [] : [method.target];
        }
        const separator = this.coerceToIntermediateString(args[0], 'String.split separator', node);
        this.assertStringSplitCollectionSize(method.target, separator, requestedLimit, node);
        return method.target.split(separator, requestedLimit);
    }
  }

  private evaluateBinary(operator: string, left: unknown, right: unknown, node: AstNode): unknown {
    switch (operator) {
      case '===':
        return left === right;
      case '!==':
        return left !== right;
      case '==':
        return left == right;
      case '!=':
        return left != right;
      case '<':
        return (left as never) < (right as never);
      case '<=':
        return (left as never) <= (right as never);
      case '>':
        return (left as never) > (right as never);
      case '>=':
        return (left as never) >= (right as never);
      case '+':
        if (typeof left === 'string' || typeof right === 'string') {
          return this.concatenateStrings(
            this.coerceToIntermediateString(left, 'String concatenation operand', node),
            this.coerceToIntermediateString(right, 'String concatenation operand', node),
            node,
          );
        }
        return (left as never) + (right as never);
      case '-':
        return Number(left) - Number(right);
      case '*':
        return Number(left) * Number(right);
      case '/':
        return Number(left) / Number(right);
      case '%':
        return Number(left) % Number(right);
      default:
        throw unsupported(node, `Unsupported binary operator: ${operator}`);
    }
  }

  private concatenateStrings(left: string, right: string, node: AstNode): string {
    const budget = createRawByteBudget(this.limits.maxIntermediateBytes);
    countRawString(left, budget);
    countRawString(right, budget);
    if (budget.bytes > budget.limit) {
      throw new InterpreterError('limit_exceeded', 'Intermediate string byte limit exceeded', node);
    }
    return left + right;
  }

  private assertIntermediateString(value: string, label: string, node: AstNode): string {
    if (
      rawStringByteLengthAtMost(value, this.limits.maxIntermediateBytes) >
      this.limits.maxIntermediateBytes
    ) {
      throw new InterpreterError('limit_exceeded', `${label} byte limit exceeded`, node);
    }
    return value;
  }

  private coerceToIntermediateString(value: unknown, label: string, node: AstNode): string {
    if (
      stringCoercionByteLengthAtMost(value, this.limits.maxIntermediateBytes) >
      this.limits.maxIntermediateBytes
    ) {
      throw new InterpreterError('limit_exceeded', `${label} byte limit exceeded`, node);
    }
    return this.assertIntermediateString(String(value), label, node);
  }

  private assertJoinedString(
    values: readonly unknown[],
    separator: string,
    label: string,
    node: AstNode,
  ): void {
    if (
      joinedStringByteLengthAtMost(values, separator, this.limits.maxIntermediateBytes) >
      this.limits.maxIntermediateBytes
    ) {
      throw new InterpreterError('limit_exceeded', `${label} byte limit exceeded`, node);
    }
  }

  private sortUtf16Values(target: unknown[], node: AstNode): void {
    const budget = createRawByteBudget(this.limits.maxIntermediateBytes);
    const decorated: Array<{ value: unknown; text: string | undefined; index: number }> = [];
    for (let index = 0; index < target.length; index += 1) {
      if ((index & 0xff) === 0) this.checkWallTime(node);
      const value = target[index];
      if (value !== undefined && !countStringCoercion(value, budget, new Set(), false)) {
        throw new InterpreterError('limit_exceeded', 'Array.sort byte limit exceeded', node);
      }
      decorated.push({ value, text: value === undefined ? undefined : String(value), index });
    }

    let comparisons = 0;
    decorated.sort((left, right) => {
      if ((comparisons++ & 0xff) === 0) this.checkWallTime(node);
      if (left.text === undefined) return right.text === undefined ? left.index - right.index : 1;
      if (right.text === undefined) return -1;
      if (left.text < right.text) return -1;
      if (left.text > right.text) return 1;
      return left.index - right.index;
    });
    this.checkWallTime(node);
    for (let index = 0; index < decorated.length; index += 1) {
      target[index] = decorated[index].value;
    }
  }

  private assertCollectionSize(size: number, label: string, node: AstNode): void {
    if (size > this.limits.maxCollectionItems) {
      throw new InterpreterError('limit_exceeded', `${label} item limit exceeded`, node);
    }
  }

  private checkWallTime(node: AstNode): void {
    this.throwIfTerminalFailure();
    if (Date.now() - this.startedAt > this.limits.maxWallTimeMs) {
      throw new InterpreterError('limit_exceeded', 'Cell wall-time limit exceeded', node);
    }
  }

  private assertStringSplitCollectionSize(
    target: string,
    separator: string,
    requestedLimit: number | undefined,
    node: AstNode,
  ): void {
    const limit = normalizeStringSplitLimit(requestedLimit);
    if (limit === 0) return;
    const maxItems = this.limits.maxCollectionItems;
    if (separator.length === 0) {
      this.assertCollectionSize(
        limit === undefined ? target.length : Math.min(target.length, limit),
        'String.split',
        node,
      );
      return;
    }
    if (limit !== undefined && limit <= maxItems && limit <= 1) return;
    let items = 1;
    let offset = 0;
    for (;;) {
      const separatorIndex = target.indexOf(separator, offset);
      if (separatorIndex < 0) return;
      items += 1;
      this.assertCollectionSize(items, 'String.split', node);
      if (limit !== undefined && items >= limit) return;
      offset = separatorIndex + separator.length;
    }
  }

  private evaluateUnary(operator: string, value: unknown, node: AstNode): unknown {
    switch (operator) {
      case '!':
        return !value;
      case '+':
        return Number(value);
      case '-':
        return -Number(value);
      case 'typeof':
        return value === null ? 'object' : typeof value;
      case 'void':
        return undefined;
      default:
        throw unsupported(node, `Unsupported unary operator: ${operator}`);
    }
  }

  private callPromiseMethod(
    name: PromiseMethodReference['name'],
    value: unknown,
    node: AstNode,
  ): CellPromise {
    if (name === 'resolve') return this.ownPromise(resolveCellValue(value));
    if (name === 'reject') return this.ownPromise(Promise.reject(value));
    if (value instanceof CellPromise) {
      return this.ownPromise(
        value.observe().then((resolved) => this.promiseCollection(name, resolved, node)),
      );
    }
    return this.ownPromise(this.promiseCollection(name, value, node));
  }

  private promiseCollection(
    name: 'all' | 'allSettled',
    value: unknown,
    node: AstNode,
  ): Promise<unknown> {
    if (!Array.isArray(value)) {
      throw new InterpreterError('execution_error', `Promise.${name} expects an array`, node);
    }
    this.assertCollectionSize(value.length, `Promise.${name}`, node);
    const promises = value.map(resolveCellValue);
    if (name === 'all') {
      return Promise.all(promises).then((items) => {
        assertByteLimit(items, this.limits.maxIntermediateBytes, 'Promise.all');
        return items;
      });
    }
    return Promise.allSettled(promises).then((items) => {
      const settled = items.map((item) =>
        item.status === 'fulfilled'
          ? { status: 'fulfilled', value: item.value }
          : { status: 'rejected', reason: caughtReason(item.reason) },
      );
      assertByteLimit(settled, this.limits.maxIntermediateBytes, 'Promise.allSettled');
      return settled;
    });
  }

  private callArrayMethod(
    method: ArrayMethodReference,
    callback: CellFunction,
    node: AstNode,
  ): CellPromise {
    this.assertCollectionSize(method.target.length, `Array.${method.name}`, node);
    return this.ownPromise(
      (async () => {
        const values = new Array<unknown>(method.target.length);
        const included = new Array<boolean>(method.target.length).fill(false);
        let retainedValues = 0;
        let serializedBytes = 2;
        await Promise.all(
          method.target.map(async (targetValue, index) => {
            const callbackValue = await this.invokeFunction(callback, [
              targetValue,
              index,
              method.target,
            ]);
            if (method.name === 'filter' && !callbackValue) return;
            const value = method.name === 'filter' ? targetValue : callbackValue;
            const separatorBytes = retainedValues === 0 ? 0 : 1;
            const remaining = this.limits.maxIntermediateBytes - serializedBytes - separatorBytes;
            const valueBytes = serializedByteLength(value, Math.max(0, remaining));
            if (remaining < 0 || valueBytes > remaining) {
              throw new InterpreterError(
                'limit_exceeded',
                `Array.${method.name} byte limit exceeded`,
                node,
              );
            }
            serializedBytes += separatorBytes + valueBytes;
            retainedValues += 1;
            values[index] = value;
            included[index] = true;
          }),
        );
        return method.name === 'filter'
          ? values.filter((_value, index) => included[index])
          : values;
      })(),
    );
  }

  private async invokeFunction(fn: CellFunction, args: readonly unknown[]): Promise<unknown> {
    const env = new Environment(fn.closure);
    for (const [index, parameter] of fn.parameters.entries()) {
      await this.declarePattern(parameter, args[index], env, false);
    }
    if (fn.expressionBody) {
      return resolveCellValue(await this.evaluateExpression(fn.body, env));
    }
    try {
      await this.evaluateStatement(fn.body, env);
      return null;
    } catch (signal) {
      if (!(signal instanceof ReturnSignal)) throw signal;
      return resolveCellValue(signal.value);
    }
  }

  private async callTool(name: string, value: unknown, node: AstNode): Promise<unknown> {
    this.throwIfTerminalFailure();
    if (this.toolCalls.length >= this.limits.maxToolCalls) {
      throw new InterpreterError('limit_exceeded', 'Tool-call limit exceeded', node);
    }
    if (this.activeToolCalls >= this.limits.maxConcurrency) {
      throw new InterpreterError('limit_exceeded', 'Tool concurrency limit exceeded', node);
    }
    const input = copyPlainData(
      value,
      `arguments for ${name}`,
      this.limits.maxDataDepth,
      0,
      new Set(),
      this.limits.maxCollectionItems,
    );
    assertByteLimit(input, this.limits.maxIntermediateBytes, 'tool arguments');
    const call = { index: this.toolCalls.length + 1, name };
    this.toolCalls.push(call);
    this.activeToolCalls += 1;
    try {
      const operation = this.input.callTool(name, input, this.cellAbortController.signal);
      this.hostToolOperations.push(operation);
      const output = await awaitWithAbort(operation, this.cellAbortController.signal);
      const copied = copyPlainData(
        output,
        `result from ${name}`,
        this.limits.maxDataDepth,
        0,
        new Set(),
        this.limits.maxCollectionItems,
      );
      assertByteLimit(copied, this.limits.maxResultBytes, `result from ${name}`);
      return copied;
    } catch (error) {
      if (this.input.signal?.aborted) throw abortReason(this.input.signal);
      if (this.cellAbortController.signal.aborted) {
        throw abortReason(this.cellAbortController.signal);
      }
      if (this.input.isFatalToolError?.(error)) {
        this.terminalFailure = { reason: error };
        throw error;
      }
      if (error instanceof InterpreterError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new InterpreterError('tool_failure', `Tool ${name} failed: ${message}`, node);
    } finally {
      this.activeToolCalls -= 1;
    }
  }

  private async tick(node: AstNode): Promise<void> {
    if (this.input.signal?.aborted) throw abortReason(this.input.signal);
    if (this.cellAbortController.signal.aborted) {
      throw abortReason(this.cellAbortController.signal);
    }
    this.steps += 1;
    if (this.steps > this.limits.maxSteps) {
      throw new InterpreterError('limit_exceeded', 'Interpreter step limit exceeded', node);
    }
    if (Date.now() - this.startedAt > this.limits.maxWallTimeMs) {
      throw new InterpreterError('limit_exceeded', 'Cell wall-time limit exceeded', node);
    }
    if (this.steps % 256 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export async function executeCodeCellImpl(
  input: ExecuteCodeCellInput,
): Promise<CodeModeExecutionResult> {
  const limits = { ...DEFAULT_CODE_MODE_LIMITS, ...input.limits };
  validateLimits(limits);
  if (new TextEncoder().encode(input.code).byteLength > limits.maxSourceBytes) {
    return {
      ok: false,
      error: { kind: 'limit_exceeded', message: 'Cell source-size limit exceeded' },
      toolCalls: [],
    };
  }
  try {
    const program = parseCell(input.code);
    validateSyntax(program);
    const rootBindings = new ValidationScope();
    for (const name of RESERVED_ROOT_BINDINGS) rootBindings.declare(name);
    validateReferences(program, new Set(input.tools.map((tool) => tool.name)), rootBindings);
    return await new Interpreter(input).execute(program);
  } catch (error) {
    if (input.signal?.aborted) throw abortReason(input.signal);
    if (input.isFatalToolError?.(error)) throw error;
    return { ok: false, error: normalizeError(error), toolCalls: [] };
  }
}

function validateSyntax(node: AstNode): void {
  if (!SUPPORTED_SYNTAX_NODES.has(node.type)) {
    throw unsupported(node, `Unsupported syntax: ${node.type}`);
  }

  switch (node.type) {
    case 'VariableDeclaration': {
      const kind = field(node, 'kind');
      if (kind !== 'const' && kind !== 'let') {
        throw unsupported(node, `Unsupported declaration kind: ${String(kind)}`);
      }
      break;
    }
    case 'VariableDeclarator':
      validateBindingPattern(ast(node, 'id'));
      break;
    case 'ArrowFunctionExpression':
      for (const parameter of nodes(node, 'params')) validateBindingPattern(parameter);
      break;
    case 'CatchClause': {
      const parameter = optionalAst(node, 'param');
      if (parameter) validateBindingPattern(parameter);
      break;
    }
    case 'ForOfStatement': {
      if (field(node, 'await') === true) {
        throw unsupported(node, 'for await is not supported');
      }
      const left = ast(node, 'left');
      if (left.type === 'VariableDeclaration') {
        if (nodes(left, 'declarations').length !== 1) {
          throw unsupported(left, 'for...of requires one variable declaration');
        }
      } else if (left.type !== 'Identifier') {
        throw unsupported(left, 'Only identifier assignment targets are supported');
      }
      break;
    }
    case 'BreakStatement':
    case 'ContinueStatement':
      if (optionalAst(node, 'label')) {
        throw unsupported(node, 'Labeled loop control is not supported');
      }
      break;
    case 'Property': {
      if (field(node, 'kind') !== 'init') {
        throw unsupported(node, 'Only ordinary object properties are supported');
      }
      if (field(node, 'computed') === true) {
        throw unsupported(ast(node, 'key'), 'Computed object keys are not supported yet');
      }
      const key = ast(node, 'key');
      const value = field(key, 'value');
      if (
        key.type !== 'Identifier' &&
        !(key.type === 'Literal' && (typeof value === 'string' || typeof value === 'number'))
      ) {
        throw unsupported(key, 'Object property key must be a string');
      }
      assertSafeKey(key.type === 'Identifier' ? stringField(key, 'name') : String(value), key);
      break;
    }
    case 'AssignmentPattern':
    case 'RestElement':
      validateBindingPattern(ast(node, node.type === 'AssignmentPattern' ? 'left' : 'argument'));
      break;
    case 'MemberExpression': {
      const property = ast(node, 'property');
      if (field(node, 'computed') === true && staticMemberName(node) === undefined) {
        throw unsupported(node, 'Computed member access requires a static string or number');
      }
      if (field(node, 'computed') !== true && property.type !== 'Identifier') {
        throw unsupported(property, 'Invalid member property');
      }
      const staticProperty = staticMemberName(node);
      if (staticProperty !== undefined) assertSafeKey(staticProperty, node);
      break;
    }
    case 'CallExpression': {
      if (nodes(node, 'arguments').some((argument) => argument.type === 'SpreadElement')) {
        throw unsupported(node, 'Spread call arguments are not supported');
      }
      const callee = ast(node, 'callee');
      if (callee.type !== 'MemberExpression') {
        throw unsupported(node, 'Only calls to supported member methods are allowed');
      }
      const member = staticMemberName(callee);
      if (member === undefined) {
        throw unsupported(callee, 'Computed calls require a static member name');
      }
      const memberObject = ast(callee, 'object');
      const memberObjectName =
        memberObject.type === 'Identifier' ? stringField(memberObject, 'name') : undefined;
      if (member === 'race' && memberObjectName === 'Promise') {
        throw unsupported(
          callee,
          'Promise.race is not supported because nested tool calls cannot escape a cell',
        );
      }
      assertSafeKey(member, callee);
      if (
        memberObjectName !== 'tools' &&
        !(memberObjectName === 'Promise' && SUPPORTED_PROMISE_METHODS.has(member)) &&
        !(
          (memberObjectName === 'JSON' || memberObjectName === 'Object') &&
          SUPPORTED_DATA_METHODS.has(member)
        ) &&
        !SUPPORTED_COLLECTION_METHODS.has(member)
      ) {
        throw unsupported(callee, `Unsupported member method: ${member}`);
      }
      break;
    }
    case 'BinaryExpression': {
      const operator = stringField(node, 'operator');
      if (!SUPPORTED_BINARY_OPERATORS.has(operator)) {
        throw unsupported(node, `Unsupported binary operator: ${operator}`);
      }
      break;
    }
    case 'LogicalExpression': {
      const operator = stringField(node, 'operator');
      if (!SUPPORTED_LOGICAL_OPERATORS.has(operator)) {
        throw unsupported(node, `Unsupported logical operator: ${operator}`);
      }
      break;
    }
    case 'UnaryExpression': {
      const operator = stringField(node, 'operator');
      if (!SUPPORTED_UNARY_OPERATORS.has(operator)) {
        throw unsupported(node, `Unsupported unary operator: ${operator}`);
      }
      break;
    }
    case 'AssignmentExpression': {
      const operator = stringField(node, 'operator');
      if (!SUPPORTED_ASSIGNMENT_OPERATORS.has(operator)) {
        throw unsupported(node, `Unsupported assignment operator: ${operator}`);
      }
      const left = ast(node, 'left');
      if (left.type !== 'Identifier') {
        throw unsupported(left, 'Only identifier assignment targets are supported');
      }
      break;
    }
    case 'UpdateExpression': {
      const operator = stringField(node, 'operator');
      if (!SUPPORTED_UPDATE_OPERATORS.has(operator)) {
        throw unsupported(node, `Unsupported update operator: ${operator}`);
      }
      const argument = ast(node, 'argument');
      if (argument.type !== 'Identifier') {
        throw unsupported(argument, 'Update expressions require an identifier');
      }
      break;
    }
  }

  for (const value of Object.values(node)) {
    if (isAstNode(value)) validateSyntax(value);
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (isAstNode(item)) validateSyntax(item);
      }
    }
  }
}

class ValidationScope {
  private readonly bindings = new Set<string>();

  constructor(private readonly parent?: ValidationScope) {}

  declare(name: string): void {
    this.bindings.add(name);
  }

  has(name: string): boolean {
    return this.bindings.has(name) || this.parent?.has(name) === true;
  }
}

function validateReferences(
  node: AstNode,
  toolNames: ReadonlySet<string>,
  scope: ValidationScope,
  parent?: AstNode,
  parentField?: string,
): void {
  if (node.type === 'BlockStatement') {
    const blockScope = new ValidationScope(scope);
    const statements = nodes(node, 'body');
    for (const statement of statements) {
      if (statement.type === 'VariableDeclaration') {
        declareVariableBindings(statement, blockScope);
      }
    }
    for (const statement of statements)
      validateReferences(statement, toolNames, blockScope, node, 'body');
    return;
  }
  if (node.type === 'VariableDeclaration') {
    for (const declaration of nodes(node, 'declarations')) {
      validatePatternReferences(ast(declaration, 'id'), toolNames, scope);
      const init = optionalAst(declaration, 'init');
      if (init) validateReferences(init, toolNames, scope, declaration, 'init');
    }
    return;
  }
  if (node.type === 'ArrowFunctionExpression') {
    const functionScope = new ValidationScope(scope);
    for (const parameter of nodes(node, 'params')) declarePatternBindings(parameter, functionScope);
    for (const parameter of nodes(node, 'params')) {
      validatePatternReferences(parameter, toolNames, functionScope);
    }
    validateReferences(ast(node, 'body'), toolNames, functionScope, node, 'body');
    return;
  }
  if (node.type === 'CatchClause') {
    const catchScope = new ValidationScope(scope);
    const parameter = optionalAst(node, 'param');
    if (parameter) {
      declarePatternBindings(parameter, catchScope);
      validatePatternReferences(parameter, toolNames, catchScope);
    }
    validateReferences(ast(node, 'body'), toolNames, catchScope, node, 'body');
    return;
  }
  if (node.type === 'ForOfStatement') {
    validateReferences(ast(node, 'right'), toolNames, scope, node, 'right');
    const left = ast(node, 'left');
    if (left.type === 'VariableDeclaration') {
      const loopScope = new ValidationScope(scope);
      declareVariableBindings(left, loopScope);
      for (const declaration of nodes(left, 'declarations')) {
        validatePatternReferences(ast(declaration, 'id'), toolNames, loopScope);
      }
      validateReferences(ast(node, 'body'), toolNames, loopScope, node, 'body');
    } else {
      validateReferences(left, toolNames, scope, node, 'left');
      validateReferences(ast(node, 'body'), toolNames, scope, node, 'body');
    }
    return;
  }
  if (node.type === 'ForStatement') {
    const loopScope = new ValidationScope(scope);
    const init = optionalAst(node, 'init');
    if (init?.type === 'VariableDeclaration') declareVariableBindings(init, loopScope);
    if (init) validateReferences(init, toolNames, loopScope, node, 'init');
    const test = optionalAst(node, 'test');
    if (test) validateReferences(test, toolNames, loopScope, node, 'test');
    const update = optionalAst(node, 'update');
    if (update) validateReferences(update, toolNames, loopScope, node, 'update');
    validateReferences(ast(node, 'body'), toolNames, loopScope, node, 'body');
    return;
  }
  if (node.type === 'AssignmentExpression' || node.type === 'UpdateExpression') {
    const target = ast(node, node.type === 'AssignmentExpression' ? 'left' : 'argument');
    if (target.type === 'Identifier' && stringField(target, 'name') === 'undefined') {
      throw unsupported(target, 'Cannot assign to reserved interpreter root "undefined"');
    }
  }
  if (node.type === 'Identifier') {
    const name = stringField(node, 'name');
    if (
      MEMBER_ROOT_BINDINGS.has(name) &&
      !isDirectRootMemberReceiver(parent, parentField) &&
      !isStaticPropertyName(parent, parentField)
    ) {
      throw unsupported(
        node,
        `Interpreter root "${name}" may only be used as a direct member receiver`,
      );
    }
    if (!isStaticPropertyName(parent, parentField) && !scope.has(name)) {
      throw new InterpreterError('execution_error', `Unknown identifier "${name}"`, node);
    }
    return;
  }
  if (node.type === 'MemberExpression') {
    const object = ast(node, 'object');
    if (object.type === 'Identifier' && stringField(object, 'name') === 'tools') {
      const name = staticMemberName(node);
      if (name !== undefined && !toolNames.has(name)) {
        throw new InterpreterError('unknown_tool', `Unknown or inactive tool "${name}"`, node);
      }
    }
    validateReferences(object, toolNames, scope, node, 'object');
    return;
  }
  if (node.type === 'Property') {
    validateReferences(ast(node, 'value'), toolNames, scope, node, 'value');
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (isAstNode(value)) validateReferences(value, toolNames, scope, node, key);
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (isAstNode(item)) validateReferences(item, toolNames, scope, node, key);
      }
    }
  }
}

function declareVariableBindings(declaration: AstNode, scope: ValidationScope): void {
  for (const declarator of nodes(declaration, 'declarations')) {
    declarePatternBindings(ast(declarator, 'id'), scope);
  }
}

function declarePatternBindings(pattern: AstNode, scope: ValidationScope): void {
  if (pattern.type === 'Identifier') {
    scope.declare(stringField(pattern, 'name'));
    return;
  }
  if (pattern.type === 'AssignmentPattern') {
    declarePatternBindings(ast(pattern, 'left'), scope);
    return;
  }
  if (pattern.type === 'RestElement') {
    declarePatternBindings(ast(pattern, 'argument'), scope);
    return;
  }
  if (pattern.type === 'ArrayPattern') {
    for (const item of arrayField(pattern, 'elements')) {
      if (item !== null) declarePatternBindings(asAst(item, pattern), scope);
    }
    return;
  }
  if (pattern.type === 'ObjectPattern') {
    for (const property of nodes(pattern, 'properties')) {
      declarePatternBindings(
        property.type === 'RestElement' ? ast(property, 'argument') : ast(property, 'value'),
        scope,
      );
    }
  }
}

function validatePatternReferences(
  pattern: AstNode,
  toolNames: ReadonlySet<string>,
  scope: ValidationScope,
): void {
  if (pattern.type === 'AssignmentPattern') {
    validatePatternReferences(ast(pattern, 'left'), toolNames, scope);
    validateReferences(ast(pattern, 'right'), toolNames, scope, pattern, 'right');
    return;
  }
  if (pattern.type === 'RestElement') {
    validatePatternReferences(ast(pattern, 'argument'), toolNames, scope);
    return;
  }
  if (pattern.type === 'ArrayPattern') {
    for (const item of arrayField(pattern, 'elements')) {
      if (item !== null) validatePatternReferences(asAst(item, pattern), toolNames, scope);
    }
    return;
  }
  if (pattern.type === 'ObjectPattern') {
    for (const property of nodes(pattern, 'properties')) {
      validatePatternReferences(
        property.type === 'RestElement' ? ast(property, 'argument') : ast(property, 'value'),
        toolNames,
        scope,
      );
    }
  }
}

function isDirectRootMemberReceiver(
  parent: AstNode | undefined,
  parentField: string | undefined,
): boolean {
  return parent?.type === 'MemberExpression' && parentField === 'object';
}

function isStaticPropertyName(
  parent: AstNode | undefined,
  parentField: string | undefined,
): boolean {
  return (
    (parentField === 'property' &&
      parent?.type === 'MemberExpression' &&
      field(parent, 'computed') !== true) ||
    (parentField === 'key' && parent?.type === 'Property' && field(parent, 'computed') !== true)
  );
}

function validateBindingPattern(pattern: AstNode): void {
  if (pattern.type === 'Identifier') {
    const name = stringField(pattern, 'name');
    if (RESERVED_ROOT_BINDINGS.has(name)) {
      throw unsupported(pattern, `Cannot shadow reserved interpreter root "${name}"`);
    }
    return;
  }
  if (pattern.type === 'AssignmentPattern') {
    validateBindingPattern(ast(pattern, 'left'));
    return;
  }
  if (pattern.type === 'RestElement') {
    validateBindingPattern(ast(pattern, 'argument'));
    return;
  }
  if (pattern.type === 'ArrayPattern') {
    for (const item of arrayField(pattern, 'elements')) {
      if (item !== null) validateBindingPattern(asAst(item, pattern));
    }
    return;
  }
  if (pattern.type === 'ObjectPattern') {
    for (const property of nodes(pattern, 'properties')) {
      if (property.type === 'RestElement') {
        validateBindingPattern(ast(property, 'argument'));
      } else if (property.type === 'Property' && field(property, 'kind') === 'init') {
        validateBindingPattern(ast(property, 'value'));
      } else {
        throw unsupported(property, 'Unsupported object binding property');
      }
    }
    return;
  }
  throw unsupported(pattern, `Unsupported binding pattern: ${pattern.type}`);
}

function staticMemberName(node: AstNode): string | undefined {
  const property = ast(node, 'property');
  if (field(node, 'computed') !== true && property.type === 'Identifier') {
    return stringField(property, 'name');
  }
  const value = field(property, 'value');
  return property.type === 'Literal' && (typeof value === 'string' || typeof value === 'number')
    ? String(value)
    : undefined;
}

function stringIndex(property: string): number | undefined {
  if (!/^(?:0|[1-9]\d*)$/u.test(property)) return undefined;
  const index = Number(property);
  return Number.isSafeInteger(index) ? index : undefined;
}

function isAstNode(value: unknown): value is AstNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as AstNode).type === 'string'
  );
}

function parseCell(code: string): AstNode {
  const transpiled = transpileModule(`async function __maka_cell__() {\n${code}\n}`, {
    reportDiagnostics: true,
    compilerOptions: { target: ScriptTarget.ESNext, module: ModuleKind.ESNext },
  });
  const diagnostic = transpiled.diagnostics?.find(
    (item) => item.category === DiagnosticCategory.Error,
  );
  if (diagnostic) {
    throw new InterpreterError(
      'parse_error',
      `Failed to parse TypeScript: ${flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = parse(transpiled.outputText, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      locations: true,
    });
  } catch (error) {
    throw new InterpreterError(
      'parse_error',
      error instanceof Error ? error.message : 'Failed to parse JavaScript',
    );
  }
  const root = asAst(parsed);
  const wrapper = nodes(root, 'body').find(
    (node) =>
      node.type === 'FunctionDeclaration' && optionalAst(node, 'id')?.name === '__maka_cell__',
  );
  if (!wrapper) throw new InterpreterError('parse_error', 'Cell wrapper could not be parsed');
  return ast(wrapper, 'body');
}

function copyPlainData(
  value: unknown,
  label: string,
  maxDepth: number,
  depth = 0,
  seen = new Set<object>(),
  maxCollectionItems = Number.MAX_SAFE_INTEGER,
  preserveUndefined = false,
  budget: CopyBudget = {
    nodes: 0,
    maxNodes: MAX_COPY_NODES,
  },
): unknown {
  if (depth > maxDepth)
    throw new InterpreterError('invalid_data', `${label} exceeds the data-depth limit`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new InterpreterError('invalid_data', `${label} contains a non-finite number`);
    return value;
  }
  if (value === undefined) return preserveUndefined ? undefined : null;
  if (typeof value !== 'object')
    throw new InterpreterError('invalid_data', `${label} contains a non-data value`);
  budget.nodes += 1;
  if (budget.nodes > budget.maxNodes) {
    throw new InterpreterError('limit_exceeded', `${label} traversal limit exceeded`);
  }
  if (seen.has(value)) throw new InterpreterError('invalid_data', `${label} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > maxCollectionItems) {
        throw new InterpreterError('limit_exceeded', `${label} item limit exceeded`);
      }
      return value.map((item) =>
        copyPlainData(
          item,
          label,
          maxDepth,
          depth + 1,
          seen,
          maxCollectionItems,
          preserveUndefined,
          budget,
        ),
      );
    }
    if (!isPlainRecord(value))
      throw new InterpreterError('invalid_data', `${label} contains a host object`);
    if (Object.keys(value).length > maxCollectionItems) {
      throw new InterpreterError('limit_exceeded', `${label} item limit exceeded`);
    }
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      assertSafeKey(key);
      output[key] = copyPlainData(
        item,
        label,
        maxDepth,
        depth + 1,
        seen,
        maxCollectionItems,
        preserveUndefined,
        budget,
      );
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertByteLimit(value: unknown, limit: number, label: string): void {
  const bytes = serializedByteLength(value, limit);
  if (bytes > limit) throw new InterpreterError('limit_exceeded', `${label} byte limit exceeded`);
}

function assertSafeKey(key: string, node?: AstNode): void {
  if (DANGEROUS_KEYS.has(key)) {
    throw new InterpreterError('invalid_data', `Property "${key}" is not allowed`, node);
  }
}

interface RawByteBudget {
  bytes: number;
  limit: number;
}

function createRawByteBudget(maxBytes: number): RawByteBudget {
  const limit =
    Number.isFinite(maxBytes) && maxBytes >= 0 ? Math.floor(maxBytes) : Number.POSITIVE_INFINITY;
  return { bytes: 0, limit };
}

function rawStringByteLengthAtMost(value: string, maxBytes: number): number {
  const budget = createRawByteBudget(maxBytes);
  countRawString(value, budget);
  return budget.bytes;
}

function countRawString(value: string, budget: RawByteBudget): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    let bytes: number;
    if (code <= 0x7f) {
      bytes = 1;
    } else if (code <= 0x7ff) {
      bytes = 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes = 4;
        index += 1;
      } else {
        bytes = 3;
      }
    } else {
      bytes = 3;
    }
    if (!addRawBytes(budget, bytes)) return false;
  }
  return true;
}

function stringCoercionByteLengthAtMost(value: unknown, maxBytes: number): number {
  const budget = createRawByteBudget(maxBytes);
  countStringCoercion(value, budget, new Set(), false);
  return budget.bytes;
}

function joinedStringByteLengthAtMost(
  values: readonly unknown[],
  separator: string,
  maxBytes: number,
): number {
  const budget = createRawByteBudget(maxBytes);
  countJoinedString(values, separator, budget, new Set());
  return budget.bytes;
}

function countJoinedString(
  values: readonly unknown[],
  separator: string,
  budget: RawByteBudget,
  arrays: Set<readonly unknown[]>,
): boolean {
  if (arrays.has(values)) return true;
  arrays.add(values);
  try {
    for (let index = 0; index < values.length; index += 1) {
      if (index > 0 && !countRawString(separator, budget)) return false;
      if (!countStringCoercion(values[index], budget, arrays, true)) return false;
    }
    return true;
  } finally {
    arrays.delete(values);
  }
}

function countStringCoercion(
  value: unknown,
  budget: RawByteBudget,
  arrays: Set<readonly unknown[]>,
  arrayElement: boolean,
): boolean {
  if (arrayElement && (value === null || value === undefined)) return true;
  if (Array.isArray(value)) return countJoinedString(value, ',', budget, arrays);
  return countRawString(String(value), budget);
}

function addRawBytes(budget: RawByteBudget, bytes: number): boolean {
  if (budget.bytes > Number.MAX_SAFE_INTEGER - bytes) {
    budget.bytes = Number.POSITIVE_INFINITY;
    return false;
  }
  if (budget.bytes + bytes > budget.limit) {
    budget.bytes =
      budget.limit < Number.MAX_SAFE_INTEGER ? budget.limit + 1 : Number.POSITIVE_INFINITY;
    return false;
  }
  budget.bytes += bytes;
  return true;
}

function normalizeStringSplitLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) return 0;
  const modulo = 2 ** 32;
  const integer = Math.trunc(value) % modulo;
  return integer < 0 ? integer + modulo : integer;
}

function validateLimits(limits: CodeModeLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function normalizeError(
  error: unknown,
): CodeModeExecutionResult extends infer _Result
  ? { kind: CodeModeDiagnosticKind; message: string; location?: { line: number; column: number } }
  : never {
  if (error instanceof InterpreterError) {
    const location = error.node?.loc?.start;
    return {
      kind: error.kind,
      message: error.message,
      ...(location
        ? { location: { line: Math.max(1, location.line - 1), column: location.column + 1 } }
        : {}),
    };
  }
  return {
    kind: 'execution_error',
    message: error instanceof Error ? error.message : String(error),
  };
}

function unsupported(node: AstNode, message: string): InterpreterError {
  return new InterpreterError('unsupported_syntax', message, node);
}

function propertyName(property: AstNode, env: Environment, interpreter: Interpreter): string {
  const key = ast(property, 'key');
  if (field(property, 'computed') === true) {
    throw unsupported(key, 'Computed object keys are not supported yet');
  }
  if (key.type === 'Identifier') return stringField(key, 'name');
  const value = field(key, 'value');
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  void env;
  void interpreter;
  throw unsupported(key, 'Object property key must be a string');
}

function asAst(value: unknown, owner?: AstNode): AstNode {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as AstNode).type !== 'string'
  ) {
    throw new InterpreterError('execution_error', 'Malformed interpreter AST', owner);
  }
  return value as AstNode;
}

function ast(node: AstNode, key: string): AstNode {
  return asAst(node[key], node);
}

function optionalAst(node: AstNode, key: string): AstNode | undefined {
  const value = node[key];
  return value === undefined || value === null ? undefined : asAst(value, node);
}

function nodes(node: AstNode, key: string): AstNode[] {
  const value = node[key];
  if (!Array.isArray(value))
    throw new InterpreterError('execution_error', `Malformed AST field "${key}"`, node);
  return value.map((item) => asAst(item, node));
}

function arrayField(node: AstNode, key: string): unknown[] {
  const value = node[key];
  if (!Array.isArray(value))
    throw new InterpreterError('execution_error', `Malformed AST field "${key}"`, node);
  return value;
}

function field(node: AstNode, key: string): unknown {
  return node[key];
}

function stringField(node: AstNode, key: string): string {
  const value = node[key];
  if (typeof value !== 'string')
    throw new InterpreterError('execution_error', `Malformed AST field "${key}"`, node);
  return value;
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ?? Object.assign(new Error('Code Mode cell aborted'), { name: 'AbortError' })
  );
}

async function resolveCellValue(value: unknown): Promise<unknown> {
  return value instanceof CellPromise ? await value.observe() : value;
}

async function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function caughtReason(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: 'Error', message: String(error) };
}
