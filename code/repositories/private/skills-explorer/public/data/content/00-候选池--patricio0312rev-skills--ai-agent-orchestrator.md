---
name: ai-agent-orchestrator
description: Orchestrates multi-agent AI systems with task delegation, agent communication, shared memory, and workflow coordination. Use when users request "multi-agent system", "agent orchestration", "AI agents", "agent coordination", or "autonomous agents".
---

# AI Agent Orchestrator

Build coordinated multi-agent systems for complex task automation.

## Core Workflow

1. **Define agents**: Create specialized agents
2. **Design workflow**: Plan agent coordination
3. **Implement handoffs**: Agent-to-agent communication
4. **Add shared memory**: Persistent context
5. **Create supervisor**: Orchestrate execution
6. **Monitor execution**: Track agent activities

## Agent Architecture

### Agent Definition

```typescript
// agents/base.ts
import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage, AIMessage } from "@langchain/core/messages";

export interface AgentConfig {
  name: string;
  role: string;
  systemPrompt: string;
  tools?: Tool[];
  model?: string;
}

export interface AgentResponse {
  content: string;
  toolCalls?: ToolCall[];
  nextAgent?: string;
  completed?: boolean;
}

export class Agent {
  private model: ChatOpenAI;
  private config: AgentConfig;
  private messageHistory: BaseMessage[] = [];

  constructor(config: AgentConfig) {
    this.config = config;
    this.model = new ChatOpenAI({
      modelName: config.model || "gpt-4-turbo-preview",
      temperature: 0.7,
    });
  }

  async execute(input: string, context?: Record<string, any>): Promise<AgentResponse> {
    const systemMessage = new SystemMessage(this.buildSystemPrompt(context));

    const messages = [systemMessage, ...this.messageHistory, new HumanMessage(input)];

    const response = await this.model.invoke(messages, {
      tools: this.config.tools,
    });

    this.messageHistory.push(new HumanMessage(input));
    this.messageHistory.push(new AIMessage(response.content as string));

    return this.parseResponse(response);
  }

  private buildSystemPrompt(context?: Record<string, any>): string {
    let prompt = this.config.systemPrompt;

    if (context) {
      prompt += `\n\nContext:\n${JSON.stringify(context, null, 2)}`;
    }

    return prompt;
  }

  private parseResponse(response: any): AgentResponse {
    // Parse tool calls and determine next actions
    return {
      content: response.content as string,
      toolCalls: response.tool_calls,
      completed: response.content?.includes("[TASK_COMPLETE]"),
    };
  }

  clearHistory() {
    this.messageHistory = [];
  }
}
```

### Specialized Agents

```typescript
// agents/specialists.ts
import { Agent, AgentConfig } from "./base";

export const ResearchAgent = new Agent({
  name: "researcher",
  role: "Research Specialist",
  systemPrompt: `You are a research specialist. Your job is to:
- Search for and gather relevant information
- Analyze sources and extract key insights
- Summarize findings clearly
- Cite sources when possible

When you have gathered sufficient information, include [TASK_COMPLETE] in your response.
If you need help from another agent, specify: [HANDOFF:agent_name]`,
  tools: [searchTool, webScrapeTool],
});

export const WriterAgent = new Agent({
  name: "writer",
  role: "Content Writer",
  systemPrompt: `You are a professional content writer. Your job is to:
- Create engaging, well-structured content
- Adapt tone and style to the target audience
- Incorporate research and data effectively
- Edit and refine for clarity

Use the research provided to create compelling content.
When complete, include [TASK_COMPLETE].`,
});

export const ReviewerAgent = new Agent({
  name: "reviewer",
  role: "Quality Reviewer",
  systemPrompt: `You are a quality reviewer. Your job is to:
- Review content for accuracy and clarity
- Check for errors and inconsistencies
- Suggest improvements
- Approve or request revisions

Provide specific feedback. If approved, include [APPROVED].
If revisions needed, include [REVISIONS_NEEDED] with specific changes.`,
});

export const PlannerAgent = new Agent({
  name: "planner",
  role: "Task Planner",
  systemPrompt: `You are a task planner. Your job is to:
- Break down complex tasks into subtasks
- Identify which specialist agent should handle each subtask
- Create an execution order
- Track progress

Output a structured plan in JSON format:
{
  "goal": "...",
  "steps": [
    { "step": 1, "agent": "researcher", "task": "..." },
    { "step": 2, "agent": "writer", "task": "..." }
  ]
}`,
});
```

## Orchestrator

### Simple Sequential Orchestrator

```typescript
// orchestrator/sequential.ts
import { Agent } from "../agents/base";

interface WorkflowStep {
  agent: Agent;
  task: string;
  inputFrom?: string;
}

export class SequentialOrchestrator {
  private agents: Map<string, Agent> = new Map();
  private results: Map<string, string> = new Map();

  registerAgent(name: string, agent: Agent) {
    this.agents.set(name, agent);
  }

  async execute(workflow: WorkflowStep[]): Promise<Record<string, string>> {
    for (const step of workflow) {
      const agent = step.agent;

      // Get input from previous step if specified
      let input = step.task;
      if (step.inputFrom && this.results.has(step.inputFrom)) {
        input = `${step.task}\n\nPrevious output:\n${this.results.get(step.inputFrom)}`;
      }

      console.log(`Executing: ${agent.name} - ${step.task}`);

      const result = await agent.execute(input);
      this.results.set(agent.name, result.content);

      console.log(`Completed: ${agent.name}`);
    }

    return Object.fromEntries(this.results);
  }
}

// Usage
const orchestrator = new SequentialOrchestrator();
orchestrator.registerAgent("researcher", ResearchAgent);
orchestrator.registerAgent("writer", WriterAgent);
orchestrator.registerAgent("reviewer", ReviewerAgent);

const results = await orchestrator.execute([
  { agent: ResearchAgent, task: "Research the latest AI trends in 2024" },
  { agent: WriterAgent, task: "Write a blog post about AI trends", inputFrom: "researcher" },
  { agent: ReviewerAgent, task: "Review the blog post", inputFrom: "writer" },
]);
```

### Supervisor Orchestrator

```typescript
// orchestrator/supervisor.ts
import { ChatOpenAI } from "@langchain/openai";
import { Agent } from "../agents/base";

interface AgentRegistry {
  [name: string]: {
    agent: Agent;
    description: string;
  };
}

export class SupervisorOrchestrator {
  private supervisor: ChatOpenAI;
  private agents: AgentRegistry = {};
  private sharedContext: Record<string, any> = {};
  private maxIterations = 10;

  constructor() {
    this.supervisor = new ChatOpenAI({
      modelName: "gpt-4-turbo-preview",
      temperature: 0,
    });
  }

  registerAgent(name: string, agent: Agent, description: string) {
    this.agents[name] = { agent, description };
  }

  async execute(task: string): Promise<string> {
    let iteration = 0;
    let currentTask = task;
    const history: string[] = [];

    while (iteration < this.maxIterations) {
      iteration++;

      // Supervisor decides next action
      const decision = await this.supervise(currentTask, history);

      if (decision.complete) {
        return decision.finalResponse!;
      }

      // Execute selected agent
      const { agent } = this.agents[decision.nextAgent!];
      const result = await agent.execute(decision.agentTask!, this.sharedContext);

      // Update shared context
      this.sharedContext[decision.nextAgent!] = result.content;
      history.push(`${decision.nextAgent}: ${result.content}`);

      // Check for handoff
      if (result.nextAgent) {
        currentTask = `Continue with: ${result.content}`;
      }
    }

    throw new Error("Max iterations reached");
  }

  private async supervise(
    task: string,
    history: string[],
  ): Promise<{
    complete: boolean;
    finalResponse?: string;
    nextAgent?: string;
    agentTask?: string;
  }> {
    const agentList = Object.entries(this.agents)
      .map(([name, { description }]) => `- ${name}: ${description}`)
      .join("\n");

    const prompt = `You are a supervisor coordinating AI agents.

Available agents:
${agentList}

Task: ${task}

History:
${history.join("\n")}

Decide the next action. Respond in JSON:
{
  "thought": "your reasoning",
  "complete": false,
  "nextAgent": "agent_name",
  "agentTask": "specific task for the agent"
}

Or if the task is complete:
{
  "thought": "your reasoning",
  "complete": true,
  "finalResponse": "the final answer"
}`;

    const response = await this.supervisor.invoke([{ role: "user", content: prompt }]);
    return JSON.parse(response.content as string);
  }
}
```

### Parallel Agent Execution

```typescript
// orchestrator/parallel.ts
export class ParallelOrchestrator {
  private agents: Map<string, Agent> = new Map();

  async executeParallel(
    tasks: Array<{ agentName: string; task: string }>,
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>();

    await Promise.all(
      tasks.map(async ({ agentName, task }) => {
        const agent = this.agents.get(agentName);
        if (!agent) throw new Error(`Agent ${agentName} not found`);

        const result = await agent.execute(task);
        results.set(agentName, result.content);
      }),
    );

    return results;
  }

  async fanOutFanIn(task: string, agentNames: string[], aggregator: Agent): Promise<string> {
    // Fan out: same task to multiple agents
    const parallelResults = await this.executeParallel(
      agentNames.map((name) => ({ agentName: name, task })),
    );

    // Fan in: aggregate results
    const aggregatedInput = Array.from(parallelResults.entries())
      .map(([name, result]) => `${name}:\n${result}`)
      .join("\n\n---\n\n");

    const finalResult = await aggregator.execute(
      `Synthesize these perspectives:\n\n${aggregatedInput}`,
    );

    return finalResult.content;
  }
}
```

## Shared Memory

```typescript
// memory/shared.ts
import { Redis } from "ioredis";

export class SharedMemory {
  private redis: Redis;
  private prefix: string;

  constructor(sessionId: string) {
    this.redis = new Redis(process.env.REDIS_URL!);
    this.prefix = `agent:${sessionId}:`;
  }

  async set(key: string, value: any, ttl?: number): Promise<void> {
    const serialized = JSON.stringify(value);
    if (ttl) {
      await this.redis.setex(this.prefix + key, ttl, serialized);
    } else {
      await this.redis.set(this.prefix + key, serialized);
    }
  }

  async get<T>(key: string): Promise<T | null> {
    const value = await this.redis.get(this.prefix + key);
    return value ? JSON.parse(value) : null;
  }

  async append(key: string, item: any): Promise<void> {
    const list = (await this.get<any[]>(key)) || [];
    list.push(item);
    await this.set(key, list);
  }

  async getConversation(): Promise<Message[]> {
    return (await this.get<Message[]>("conversation")) || [];
  }

  async addMessage(message: Message): Promise<void> {
    await this.append("conversation", message);
  }

  async getAgentOutputs(): Promise<Record<string, string>> {
    return (await this.get<Record<string, string>>("outputs")) || {};
  }

  async setAgentOutput(agent: string, output: string): Promise<void> {
    const outputs = await this.getAgentOutputs();
    outputs[agent] = output;
    await this.set("outputs", outputs);
  }

  async clear(): Promise<void> {
    const keys = await this.redis.keys(this.prefix + "*");
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }
}
```

## Event-Driven Agent Communication

```typescript
// events/agent-events.ts
import { EventEmitter } from "events";

export class AgentEventBus extends EventEmitter {
  private static instance: AgentEventBus;

  static getInstance(): AgentEventBus {
    if (!this.instance) {
      this.instance = new AgentEventBus();
    }
    return this.instance;
  }

  emitAgentMessage(from: string, to: string, message: any) {
    this.emit(`message:${to}`, { from, message, timestamp: new Date() });
  }

  emitAgentComplete(agent: string, result: any) {
    this.emit("agent:complete", { agent, result, timestamp: new Date() });
  }

  emitAgentError(agent: string, error: Error) {
    this.emit("agent:error", { agent, error, timestamp: new Date() });
  }

  onMessage(agentName: string, handler: (message: any) => void) {
    this.on(`message:${agentName}`, handler);
  }

  onAnyComplete(handler: (event: any) => void) {
    this.on("agent:complete", handler);
  }
}

// Usage
const eventBus = AgentEventBus.getInstance();

// Agent listens for messages
eventBus.onMessage("writer", async ({ from, message }) => {
  console.log(`Writer received from ${from}:`, message);
  const result = await WriterAgent.execute(message);
  eventBus.emitAgentComplete("writer", result);
});

// Orchestrator listens for completions
eventBus.onAnyComplete(({ agent, result }) => {
  console.log(`${agent} completed:`, result.content);
});
```

## Workflow Definition

```typescript
// workflows/definition.ts
interface WorkflowDefinition {
  name: string;
  description: string;
  agents: string[];
  steps: WorkflowStep[];
  errorHandling: "retry" | "fallback" | "abort";
}

const ContentCreationWorkflow: WorkflowDefinition = {
  name: "content-creation",
  description: "Create and publish content",
  agents: ["planner", "researcher", "writer", "reviewer"],
  steps: [
    {
      id: "plan",
      agent: "planner",
      input: "{task}",
      outputKey: "plan",
    },
    {
      id: "research",
      agent: "researcher",
      input: "Research for: {plan.topic}",
      outputKey: "research",
      parallel: true,
    },
    {
      id: "write",
      agent: "writer",
      input: "Write about {plan.topic} using research: {research}",
      outputKey: "draft",
      dependsOn: ["research"],
    },
    {
      id: "review",
      agent: "reviewer",
      input: "Review: {draft}",
      outputKey: "review",
      loop: {
        condition: "review.approved === false",
        maxIterations: 3,
        backTo: "write",
      },
    },
  ],
  errorHandling: "retry",
};
```

## Best Practices

1. **Single responsibility**: Each agent has one clear role
2. **Clear handoffs**: Explicit agent-to-agent communication
3. **Shared context**: Use memory for persistent state
4. **Iteration limits**: Prevent infinite loops
5. **Error handling**: Graceful degradation
6. **Observability**: Log all agent actions
7. **Testing**: Test agents individually and together
8. **Timeout handling**: Prevent stuck agents

## Output Checklist

Every agent system should include:

- [ ] Agent base class with common functionality
- [ ] Specialized agents with clear roles
- [ ] Orchestrator for coordination
- [ ] Shared memory system
- [ ] Event-based communication
- [ ] Workflow definitions
- [ ] Error handling and retries
- [ ] Iteration limits
- [ ] Logging and monitoring
- [ ] Agent handoff protocol
