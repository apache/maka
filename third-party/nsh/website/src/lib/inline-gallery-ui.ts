// The playground compiles one TSX module. Bundle the repository's internal
// example UI into lexical module scopes; native NSH imports stay imports.
// The normal demo/player build uses the NSH bundler instead.

type Sources = Record<string, string>;

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

function names(list: string): { imported: string; local: string }[] {
  return list.split(',').flatMap((item) => {
    const name = item.trim();
    if (!name || /^type\s/.test(name)) return [];
    const [imported, local = imported] = name.split(/\s+as\s+/);
    return [{ imported, local }];
  });
}

/** Inline the shared UI behind a demo's `./palette` import for the playground. */
export function inlineGalleryUi(source: string, sources: Sources): string {
  const paletteImport = /^import\s*\{([^}]*)\}\s*from\s*["']\.\/palette["'];?[ \t]*$/m;
  const match = paletteImport.exec(source);
  if (!match) return source;

  const natives = new Map<string, string>();
  const modules = new Map<string, string>();
  const visiting = new Set<string>();
  const chunks: string[] = [];

  const resolve = (from: string, specifier: string): string => {
    const path = normalize(`${from.slice(0, from.lastIndexOf('/'))}/${specifier}`);
    const found = [path, `${path}.ts`, `${path}.tsx`, `${path}/index.tsx`]
      .find((candidate) => Object.hasOwn(sources, candidate));
    if (!found) throw new Error(`Shared UI module ${specifier} from ${from} is missing`);
    return found;
  };

  const dependency = (from: string, specifier: string): string => {
    if (specifier.startsWith('.')) return visit(resolve(from, specifier));
    if (specifier !== 'nsh' && !specifier.startsWith('nsh/')) {
      throw new Error(`Shared UI imports an unsupported module: ${specifier}`);
    }
    let name = natives.get(specifier);
    if (!name) {
      name = `__nshGalleryNative${natives.size}`;
      natives.set(specifier, name);
    }
    return name;
  };

  function visit(id: string): string {
    if (visiting.has(id)) throw new Error(`Shared UI module cycle at ${id}`);
    const previous = modules.get(id);
    if (previous) return previous;
    const name = `__nshGalleryModule${modules.size}`;
    modules.set(id, name);
    visiting.add(id);
    const exports: string[] = [];
    const stars: string[] = [];
    let body = sources[id];
    if (body === undefined) throw new Error(`Shared UI module ${id} is missing`);
    if (id.endsWith('.json')) {
      chunks.push(`const ${name} = { default: ${JSON.stringify(JSON.parse(body))} };`);
      visiting.delete(id);
      return name;
    }

    body = body.replace(
      /^import\s+(type\s+)?([^;]+?)\s+from\s*["']([^"']+)["'];?[ \t]*$/gm,
      (_all, type: string | undefined, binding: string, specifier: string) => {
        if (type) return '';
        const target = dependency(id, specifier);
        binding = binding.trim();
        if (binding.startsWith('{')) {
          const fields = names(binding.slice(1, -1))
            .map(({ imported, local }) => `${imported}: ${local}`);
          return fields.length ? `const { ${fields.join(', ')} } = ${target};` : '';
        }
        const namespace = /^\*\s+as\s+(\w+)$/.exec(binding);
        if (namespace) return `const ${namespace[1]} = ${target};`;
        if (/^\w+$/.test(binding)) return `const ${binding} = ${target}.default;`;
        throw new Error(`Unsupported shared UI import in ${id}: ${binding}`);
      },
    );
    body = body.replace(
      /^export\s*\{([^}]*)\}\s*from\s*["']([^"']+)["'];?[ \t]*$/gm,
      (_all, list: string, specifier: string) => {
        const fields = names(list);
        if (fields.length) {
          const target = dependency(id, specifier);
          exports.push(...fields.map(({ imported, local }) => `${local}: ${target}.${imported}`));
        }
        return '';
      },
    );
    body = body.replace(
      /^export\s+\*\s+from\s*["']([^"']+)["'];?[ \t]*$/gm,
      (_all, specifier: string) => {
        stars.push(`...${dependency(id, specifier)}`);
        return '';
      },
    );
    body = body.replace(/^export\s*\{([^}]*)\};?[ \t]*$/gm, (_all, list: string) => {
      exports.push(...names(list).map(({ imported, local }) => `${local}: ${imported}`));
      return '';
    });
    for (const declaration of body.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)/gm)) {
      exports.push(declaration[1]);
    }
    body = body.replace(/^export\s+(?=(?:async\s+)?(?:function|const|let|class|interface|type)\b)/gm, '');
    if (/^(?:import|export)\s/m.test(body)) throw new Error(`Unsupported shared UI declaration in ${id}`);
    chunks.push(`const ${name} = (() => {\n${body}\nreturn { ${[...stars, ...exports].join(', ')} };\n})();`);
    visiting.delete(id);
    return name;
  }

  const palette = visit('website/demos/palette.ts');
  const theme = sources['examples/nsh-gallery-ui/theme.json'];
  if (!theme) throw new Error('Shared UI theme is missing');
  const imports = [...natives].map(([specifier, name]) => `import * as ${name} from ${JSON.stringify(specifier)};`);
  const fields = names(match[1]).map(({ imported, local }) => `${imported}: ${local}`);
  // The same setup emitted by the NSH bundler: tokens are available to
  // the first render, including the private theme's additional roles.
  const setup = [
    'import { setup as __nshGallerySetup } from "nsh:rt";',
    `__nshGallerySetup(null, ${JSON.stringify(theme)}, null, null);`,
  ];
  const inline = [...imports, ...setup, ...chunks, `const { ${fields.join(', ')} } = ${palette};`].join('\n');
  return source.slice(0, match.index) + inline + source.slice(match.index + match[0].length);
}
