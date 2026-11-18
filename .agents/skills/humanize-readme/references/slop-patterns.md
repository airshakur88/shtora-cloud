# README Slop Patterns

Reference for detecting and removing AI-generated patterns from README files.

## Banned Buzzwords

Replace these with specific, plain language. If the word can be deleted with no loss of meaning — delete it.

```
seamlessly        → just remove, or say how it actually works
robust            → remove, or say what specifically makes it reliable
scalable          → remove, or say it handles N concurrent users / X GB of data
cutting-edge      → remove
state-of-the-art  → remove
leverage          → "use"
utilize           → "use"
game-changer      → remove
comprehensive     → remove (show, don't tell)
powerful          → remove
intuitive         → remove (if it's intuitive, users will see it; don't claim it)
seamless          → remove
streamline        → remove or say how
empower           → "let you", "gives you"
enable            → "lets", "you can"
innovative        → remove
groundbreaking    → remove
revolutionary     → remove
next-generation   → remove
world-class       → remove
best-in-class     → remove
industry-leading  → remove
delve into        → "look at", "explore", "read"
dive deep         → remove filler, get to the point
in today's world  → remove entirely
ecosystem         → often fine, but watch for vague use ("a thriving ecosystem")
solution          → name the actual thing ("a CLI tool", "a library")
journey           → remove
experience        → usually removable ("user experience" → just say what it does)
it's worth noting → remove — just say the thing
let's explore     → remove — just start explaining
this is designed to → "it does X", or restructure
makes it easy to  → name what it actually does; don't claim ease
enables developers to → "lets you", or name the action
allows you to     → just say what happens ("you can do X" → "does X")
has been designed → "does", "works", "handles"
ensures           → say what it actually does (not "ensures correctness" → "validates input")
```

## Banned Opening Sentences

These openers scream AI — delete or rewrite entirely:

```
"In today's fast-paced [world/landscape/environment]..."
"This powerful tool is designed to..."
"This repository aims to provide..."
"Welcome to [ProjectName], a [adjective] [category] that..."
"[ProjectName] is a comprehensive solution for..."
"Introducing [ProjectName] — the [superlative] way to..."
"This project leverages [tech] to [vague verb] [vague noun]..."
"Built with [tech], this [project] seamlessly integrates..."
"Are you looking for a way to...?"
"This [tool/library/framework] empowers developers to..."
```

## Banned Structural Patterns

### Fake Bullet Enthusiasm

```
❌ - 🚀 Blazing fast performance
   - 💡 Intelligent auto-completion  
   - 🔥 Real-time updates
   - ✨ Seamless integration

✅ Just list what it does without emojis or adjectives
```

### Feature List Without Specifics

```
❌ - **Fast** — Optimized for performance
   - **Flexible** — Works with any workflow
   - **Simple** — Easy to use

✅ - Processes 10k records in ~2s on a laptop
   - Works with Express, Fastify, and Hono
   - One config file, no plugins needed
```

### Generic "Why Use This?" Section

```
❌ In a world with many solutions, [ProjectName] stands out by offering 
   a unique combination of features that make it the ideal choice for 
   developers who want...

✅ I built this because [X problem] was annoying me. Every existing tool 
   [did Y wrong]. This one just does Z.
```

### Suspiciously Complete Documentation

Writing for every edge case with perfectly polished prose is an AI tell. Real docs have gaps.
It's fine to say: `Not tested on Windows yet`, `This is experimental`, `PRs welcome`.

### The LinkedIn Conclusion

```
❌ In conclusion, [ProjectName] represents a significant step forward in 
   [domain]. By leveraging [tech], we have created a solution that...

✅ Just stop. No conclusion needed. Or: "That's it. Open an issue if it breaks."
```

## Before / After Examples

### Example 1 — Project description

❌ **AI slop:**

> FastCache is a comprehensive, high-performance caching solution designed to seamlessly integrate with your existing Node.js infrastructure. By leveraging cutting-edge in-memory storage techniques, FastCache empowers developers to build scalable applications with minimal configuration.

✅ **Human:**

> FastCache is a Node.js in-memory cache. It's a thin wrapper around a Map with TTL support and a dead-simple API. I wrote it because node-cache's API annoyed me.

---

### Example 2 — Feature section

❌ **AI slop:**

> ## Features
> - 🚀 **Blazing Performance**: Optimized for maximum throughput
> - 🔒 **Enterprise Security**: Built with security best practices
> - 🎯 **Intuitive API**: Designed for developer experience

✅ **Human:**

> ## What it does
> - Sub-millisecond reads for hot keys (benchmarks in `/bench`)
> - JWT validation baked in, no extra setup
> - `get(key)`, `set(key, val, ttl)`, `del(key)` — that's the whole API

---

### Example 3 — Getting started

❌ **AI slop:**

> ## Getting Started
> Welcome to the getting started guide! Follow these simple steps to begin your journey with FastCache.
> ### Prerequisites
> Before you begin, ensure you have met the following requirements...

✅ **Human:**

> ## Install
> ```bash
> npm install fastcache
> ```
> Needs Node 18+. If you're on an older version, it'll probably explode.

---

## What Good Human READMEs Have

- **A one-liner that actually explains what it does** — not what category it's in
- **Why it exists** — even one sentence ("I needed X, nothing did Y")
- **Honest limitations** — "Only tested on macOS", "Alpha, expect breakage"
- **Varied sentence lengths** — not every sentence the same length
- **Specific numbers** when relevant — not "fast", but "~50ms"
- **Direct commands** — "clone this, run that"
- **No unsolicited philosophy** about software development

## Burstiness — Vary Sentence Rhythm

The single biggest tell of AI writing is uniform sentence length. Every sentence is ~15-20 words. Same structure. Same rhythm. Same pace.

Vary it deliberately.

❌ **AI rhythm (all sentences roughly equal length):**

> FastCache provides an in-memory caching solution for Node.js applications. It supports TTL-based expiry and automatic eviction policies. The library includes a simple get/set/del API that developers can integrate quickly.

✅ **Human rhythm (short and long mixed):**

> FastCache is a Node.js in-memory cache. Thin wrapper around a Map. Supports TTL and auto-eviction. I wrote it because every other cache library I tried had an API that felt like it was designed by committee — seven methods when you need three.

Short sentences. Then a longer one that explains the why. Then short again.

## Personal Voice Signals

Real READMEs have gaps. They have opinions. They have a reason to exist.

**Add at least one of these:**

- Why the author built it: "I needed X, and nothing did Y"
- Honest limitations: "Windows support is untested", "This is alpha software"
- A specific tradeoff: "Chose X over Y because Z — if you need Z, use that instead"
- Known rough edges: "The CLI flag naming is inconsistent, sorry"
- Self-corrections: "Well, almost everything — see known issues"

These signals read as human because they are. AI doesn't volunteer its own limitations.

## README Type Conventions

Different project types have different expectations. Don't write a library README like an app README.

**CLI tool** — Lead with the command. Show a real usage example before anything else. Config flags matter.

**Library / package** — Show the import and a minimal working code snippet in the first screen. API reference belongs near the end or in separate docs.

**App / service** — Screenshot or demo link near the top helps. Architecture only if it's genuinely complex.

**Internal/company tool** — Skip "why this exists" for external audiences. Go straight to how to run it.

## What Good Human READMEs Don't Need

- A "Vision" or "Mission" section for a utility library
- An "Architecture Overview" with a 5-level diagram for a 200-line script
- A "Contributing" section that's longer than the actual docs
- "Star this repo if you find it useful!"
- A changelog in the README
