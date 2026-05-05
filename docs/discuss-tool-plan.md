# Discuss Tool - Multi-Agent Discussion System

## Overview

A tool that enables orchestrator-managed multi-agent discussions where agents can communicate peer-to-peer within the same execution context (no separate child sessions).

---

## Key Requirements

1. **Same session process** - agents run inline, no separate child sessions
2. **Orchestrator coordinates** - primary agent manages turn-taking, consensus detection
3. **Agents see each other's outputs** - peer-to-peer communication
4. **Dynamic turn order** - orchestrator decides who speaks next
5. **Sequential awareness** - Agent C sees B's feedback, D sees C and B's, etc.
6. **Progress notes** - track each turn's key contributions
7. **Consensus via analyzer subagent** - spawn dedicated agent to analyze transcript
8. **No max rounds limit** - runs until consensus OR needs user input
9. **Discussion continues after user input** - user clarifies → discussion resumes
10. **Agents not restricted to specific view** - they can raise same topic + different topics simultaneously (real discussion)

---

## Architecture

```
User asks: "Plan ecommerce architecture"

Primary Agent (Orchestrator)
    │
    │ analyzes: "This needs discussion with multiple perspectives"
    │ decides: "I'll include these agents"
    │
    │ calls discuss tool (phase 1)
    ▼
┌─────────────────────────────────────────────────────────────┐
│                  Discussion Context                          │
│                  (shared state in memory)                    │
│                                                              │
│  Orchestrator decides turn order dynamically                 │
│                                                              │
│  Round 1:                                                    │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ Turn 1: Agent A                                          ││
│  │ Prompt: "Discuss ecommerce architecture"                 ││
│  │ Discussion history: (empty, first turn)                  ││
│  │ Output: "I think we need: catalog, checkout, auth..."   ││
│  │ Note: [Proposed core components]                         ││
│  └─────────────────────────────────────────────────────────┘│
│                                                              │
│  Orchestrator sees A's output                                │
│  Orchestrator decides: "Next should be Agent B"              │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ Turn 2: Agent B                                          ││
│  │ Prompt: "Continue discussion, respond to A"              ││
│  │ Discussion history: [A's output]                         ││
│  │ Output: "A's catalog idea is good. Also consider..."    ││
│  │          "Security is critical for auth..."              ││
│  │ Note: [Agreed with catalog, raised security]             ││
│  └─────────────────────────────────────────────────────────┘│
│                                                              │
│  Orchestrator sees B's output                                │
│  Orchestrator decides: "Agent C should contribute"           │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ Turn 3: Agent C                                          ││
│  │ Prompt: "Continue discussion, respond to A and B"        ││
│  │ Discussion history: [A's output, B's output]              ││
│  │ Output: "B's security point is valid. For catalog..."   ││
│  │          "I also think we need inventory management..."  ││
│  │ Note: [Agreed on security, added inventory]              ││
│  └─────────────────────────────────────────────────────────┘│
│                                                              │
│  ... more turns                                              │
│                                                              │
│  Orchestrator decides: "Check consensus with analyzer"       │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ Analyzer Agent (via Task tool - subagent)               ││
│  │ Prompt: Full transcript + "Analyze consensus"            ││
│  │ Output: {                                               ││
│  │   consensus: ["Catalog component", "Security focus"],   ││
│  │   disagreements: ["Payment gateway choice"],            ││
│  │   status: "needs_user_input"                            ││
│  │ }                                                       ││
│  └─────────────────────────────────────────────────────────┘│
│                                                              │
│  Analyzer returns: needs user input on payment               │
│                                                              │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼
                Orchestrator reads analyzer result
                Orchestrator: "Discussion needs user input"
                         │
                         ▼
                question tool:
                "Which payment gateway? Stripe or PayPal?"
                         │
                         ▼
                User answers: "Stripe, simpler integration"
                         │
                         ▼
                Orchestrator: "Continue discussion with user input"
                calls discuss tool (phase 2)
                injects user input into discussion
                         │
                         ▼
                Discussion continues...
                Agents A, B, C respond with new context
                ...
                Analyzer: "consensus_reached"
                         │
                         ▼
                discuss tool returns:
                {
                  transcript: [Full transcript],
                  summary: {
                    consensus: [...],
                    disagreements: [],
                    recommendations: [...],
                  },
                  rounds: 3,
                  turns: 12,
                }
                         │
                         ▼
                Orchestrator synthesizes final plan
```

---

## Key Components

### 1. discuss Tool

**Parameters:**

```typescript
z.object({
  // Phase control
  phase: z.enum(["start", "continue"]).describe(
    "start = new discussion, continue = resume after user input or next turn"
  ),
  
  // Discussion identification
  discussion_id: z.string().optional().describe(
    "Resume previous discussion by ID (returned from start phase)"
  ),
  
  // Topic
  topic: z.string().describe("Discussion topic/question"),
  
  // Agents configuration
  agents: z.array(z.object({
    id: z.string().describe("Agent identifier"),
    role: z.string().optional().describe("Optional role description"),
    agent_type: z.string().describe("Base agent type: 'general', 'explore', etc."),
  })).describe("Agents participating in discussion"),
  
  // Turn control (orchestrator decides)
  next_agent: z.string().describe("Which agent should speak next"),
  
  // Context for continue phase
  user_input: z.string().optional().describe(
    "User's clarification/input to inject (for continue after user input)"
  ),
  
  transcript: z.array(z.object({
    agent: z.string(),
    output: z.string(),
    note: z.string().optional(),
    round: z.number(),
  })).optional().describe("Previous transcript (for continue phase)"),
  
  // Analysis control
  analyze: z.boolean().optional().describe(
    "Run consensus analysis (uses Task tool to spawn analyzer)"
  ),
  
  // Dynamic agent addition
  add_agent: z.object({
    id: z.string(),
    role: z.string().optional(),
    agent_type: z.string(),
  }).optional().describe("Add new agent to discussion"),
  
  // Finalization
  finalize: z.boolean().optional().describe(
    "End discussion and return final result"
  ),
})
```

### 2. Discussion State

```typescript
interface DiscussionState {
  id: string
  topic: string
  agents: AgentConfig[]
  transcript: Turn[]
  round: number
  current_turn: number
  status: "active" | "paused_for_analysis" | "paused_for_user" | "complete"
}
```

### 3. Agent Execution (Inline)

Each agent runs inline (same process), NOT via Task tool:

```typescript
// Execute agent turn inline:
const agentConfig = agents.find(a => a.id === next_agent)

const prompt = buildDiscussionPrompt({
  topic,
  discussionHistory: transcript, // all previous outputs
  userInput, // if provided
  agentRole: agentConfig.role,
})

// Call LLM directly (no child session)
const output = await llm.stream({
  agent: agentConfig.agent_type,
  prompt,
  system: [discussionSystemPrompt],
})

// Extract key note from output
const note = extractNote(output)

return { agent, output, note, round }
```

### 4. Analyzer Subagent

Uses **Task tool** (child session) specifically for consensus analysis:

```typescript
// Orchestrator calls discuss with analyze: true
// discuss tool spawns analyzer via Task tool:

Task({
  subagent_type: "general",
  description: "Analyze discussion consensus",
  prompt: `
    Analyze this discussion transcript:
    
    Topic: ${topic}
    Transcript: ${transcript.map(t => `[${t.agent}]: ${t.output}`).join("\n")}
    
    Return:
    - consensus: points where agents agree
    - disagreements: points where agents disagree
    - needs_user_input: questions needing user clarification
    - status: "consensus_reached" | "needs_resolution" | "needs_user_input"
    - recommendation: what to do next
  `,
})
```

### 5. Orchestrator Logic

Orchestrator controls the flow:

```
Phase 1: Start
  discuss({ phase: "start", topic, agents, next_agent: "A" })
  → Get Turn 1 result
  
  Orchestrator reads output, decides next_agent
  discuss({ phase: "continue", discussion_id, next_agent: "B", transcript })
  → Get Turn 2 result
  
  ... repeat ...
  
  Orchestrator decides to analyze
  discuss({ phase: "continue", discussion_id, analyze: true, transcript })
  → Get analysis result
  
  If needs_user_input:
    question tool → get user answer
    discuss({ phase: "continue", discussion_id, user_input, transcript })
    → Discussion resumes
  
  If consensus_reached or needs_resolution:
    Continue discussion OR finalize
  
  discuss({ phase: "continue", discussion_id, finalize: true, transcript })
  → Get final result (transcript + summary)
```

---

## Result Format

```typescript
interface DiscussResult {
  discussion_id: string
  
  // Single turn result
  turn?: {
    agent: string
    output: string
    note: string
    round: number
    turn_number: number
  }
  
  // Analysis result
  analysis?: {
    consensus: string[]
    disagreements: string[]
    needs_user_input: string[]
    status: "consensus_reached" | "needs_resolution" | "needs_user_input"
    recommendation: string
  }
  
  // Final result
  final?: {
    transcript: Turn[]
    summary: {
      consensus: string[]
      disagreements: string[]
      recommendations: string[]
      key_points: string[]
    }
    rounds: number
    total_turns: number
  }
}
```

---

## Discussion Prompts

### Agent Prompt Template

```
You are participating in a multi-agent discussion.

Topic: {topic}

Your Role: {role}
(You are NOT restricted to this role - you can raise any relevant points)

Previous Discussion:
{discussion_history}

{user_input_section}

Instructions:
1. Read the previous discussion carefully
2. Respond to relevant points from other agents
3. Add your own perspectives and ideas
4. You can agree, disagree, or raise new topics
5. Be constructive and specific
6. If you agree with something, explain why
7. If you disagree, explain your reasoning
8. Feel free to raise topics others haven't mentioned

Provide your contribution to the discussion.
```

### Analyzer Prompt Template

```
You are analyzing a multi-agent discussion transcript.

Topic: {topic}

Transcript:
{transcript}

Analyze and return:
1. consensus: Points where most/all agents agree
2. disagreements: Points where agents have different opinions
3. needs_user_input: Decisions that require user clarification
4. status: One of:
   - "consensus_reached": Majority agreement, ready to proceed
   - "needs_resolution": Disagreements that agents can resolve
   - "needs_user_input": Needs user to make a decision
5. recommendation: What should happen next

Return your analysis as structured JSON.
```

---

## Comparison with Current Task Tool

| Aspect | Task Tool | Discuss Tool |
|--------|-----------|--------------|
| Execution | Child session (separate) | Inline (same process) |
| Communication | Parent → child → parent | Peer-to-peer (agents see each other) |
| Turn order | Parallel execution | Orchestrator-controlled sequential |
| Discussion history | Agents isolated | Agents see full history |
| Consensus | Parent decides alone | Analyzer agent + orchestrator |
| User input | After all done | At any point, discussion continues |
| Agent roles | Fixed by agent type | Dynamic, unrestricted |

---

## Implementation Files

### Required Files

1. **`packages/opencode/src/tool/discuss.ts`** - Tool implementation
2. **`packages/opencode/src/tool/discuss.txt`** - Tool description
3. **`packages/opencode/src/discussion/state.ts`** - Discussion state management
4. **`packages/opencode/src/discussion/prompts.ts`** - Discussion prompts

### Registration

- Register in tool registry (`src/tool/registry.ts` or similar)
- Add permission configuration for discuss tool

---

## Usage Example

```
User: "I want to create an ecommerce platform. Help me plan the architecture."

Orchestrator: "I'll discuss this with multiple perspectives to get a comprehensive plan."

Orchestrator calls:
  discuss({
    phase: "start",
    topic: "Ecommerce platform architecture",
    agents: [
      { id: "architect", agent_type: "general" },
      { id: "security", agent_type: "general" },
      { id: "scalability", agent_type: "explore" },
    ],
    next_agent: "architect",
  })

[Turn 1 - architect]:
  "For ecommerce, I propose: product catalog, user accounts, checkout, payments..."

Orchestrator: "Good start. Now security perspective should review."

Orchestrator calls:
  discuss({
    phase: "continue",
    discussion_id: "...",
    next_agent: "security",
    transcript: [...],
  })

[Turn 2 - security]:
  "Architect's catalog proposal is solid. For user accounts, we need JWT auth.
   Payments should use Stripe for simplicity. Also consider: fraud prevention..."

Orchestrator: "Security raised auth and fraud. Scalability should review."

[Turn 3 - scalability]:
  "I agree with architect's components. Security's JWT suggestion works for MVP.
   For scaling: consider caching strategy, database sharding later.
   I also think we need: inventory management, order tracking..."

... more turns ...

Orchestrator: "Let me analyze consensus."

Orchestrator calls:
  discuss({
    phase: "continue",
    analyze: true,
    transcript: [...],
  })

Analyzer returns:
  {
    consensus: ["Product catalog", "User accounts with JWT", "Stripe payments"],
    disagreements: [],
    needs_user_input: ["Deployment target: cloud provider choice"],
    status: "needs_user_input",
  }

Orchestrator: "Consensus on core architecture. Need user input on deployment."

Orchestrator calls question tool:
  "Which cloud provider for deployment?"

User: "AWS, planning to scale in 6 months"

Orchestrator: "Good. Let me continue discussion with this context."

Orchestrator calls:
  discuss({
    phase: "continue",
    user_input: "AWS deployment, scale in 6 months",
    transcript: [...],
    next_agent: "architect",
  })

[Discussion continues with new context...]

Analyzer: "consensus_reached"

Orchestrator calls:
  discuss({
    phase: "continue",
    finalize: true,
    transcript: [...],
  })

Returns final result:
  {
    transcript: [...],
    summary: {
      consensus: ["Microservices-ready monolith MVP", "AWS deployment", ...],
      recommendations: [...],
    },
    rounds: 3,
    total_turns: 12,
  }

Orchestrator synthesizes final plan and writes to plan file.
```

---

## Notes

- Agents are NOT restricted to specific roles - they can raise any relevant topics
- Real discussion flow: agents can agree, disagree, add new topics freely
- Orchestrator has full control of turn order
- Analyzer is a subagent (uses Task tool) - separation of concerns
- Discussion can pause for user input and resume seamlessly
- No max rounds - runs until naturally complete