---
name: memvora-frontend
description: Build Memvora Next.js App Router screens for repository setup, capture sessions, memory timelines, or asking past work, with truthful integration states and accessible evidence navigation.
---

# Build a clear engineering-memory interface

Read the relevant product flow in `docs/PRD.md`, then inspect `apps/web` and its installed Next.js and React versions. Follow the existing styling and routing conventions. Check official documentation for version-sensitive routing, request, caching, or server-action APIs before adopting them.

## Keep the boundaries clear

Use Server Components for server-owned data and secrets. Add client boundaries only for interaction, browser APIs, or client-side state. Do not import database clients, credentials, server-only dependencies, or privileged API adapters into a client bundle. Share contract types and runtime validation rather than asserting remote JSON has a trusted shape.

The API and shared domain layer own access decisions. UI hiding is not authorization. Request only the scope needed for the page and handle access revocation or an unavailable service without leaking previously cached repository data.

## Make evidence and product state legible

- Give loading, empty, denied, disconnected, failed, processing, and ready states distinct behavior when applicable. An empty memory list is different from a retrieval failure.
- Label sample data or a proposed integration explicitly. Do not make a stub appear connected, show invented retrieval results, or display a success toast before the server accepts the action.
- Separate original command/output evidence from generated summaries and inferred explanations. Let users follow citations to their command, event, time, repository, and revision where available.
- Keep dangerous command text inert. Copying a command should be an explicit action; displaying an earlier fix must not execute it.
- Use semantic controls, visible focus, keyboard navigation, useful form errors, and responsive layouts. Long paths, stack traces, and output should remain readable without breaking the page width.

Verify the flow with the real configured API when available. Use clearly labeled fixtures only for deliberate preview or test states. Run the relevant web checks and inspect the rendered screen at a narrow and normal desktop width when the change affects layout. Report connection prerequisites and untested paths candidly.
