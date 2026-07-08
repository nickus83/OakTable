## Brief overview
Project-specific rules for OakTable — a P2P virtual tabletop for TTRPGs. Covers tech stack, architecture conventions, coding standards, and workflow expectations for the entire monorepo (client/ and server/).

## Tech Stack (STRICT)
- Backend: Python 3.11+, FastAPI, SQLAlchemy, WebSockets
- Frontend: React (TypeScript), PixiJS (2D rendering), Yjs (CRDT synchronization)
- Network: WebRTC (DataChannels for state/files, MediaChannels for audio)
- Architecture: Monorepo with client/ and server/ directories. Pure P2P mesh for client communication.
- Do not introduce alternative frameworks or languages without explicit approval.

## Architecture Principles
- Backend is stateless regarding P2P traffic — only handles signaling and database operations.
- Frontend shared state is managed exclusively via Yjs CRDT. Do not use Redux, Zustand, or similar for shared table state.
- P2P mesh connects 1 GM and up to 4 Players in Phase 1. Spectators are out of scope.
- Assets (PDFs, images) are stored locally and synced via WebRTC DataChannels.

## Coding Best Practices
- Write concise, production-ready code. No placeholders like "// TODO: implement logic" or "/* FIXME */".
- TypeScript strict mode is mandatory in the client. No `any` types unless justified with a comment.
- Backend code must follow ASGI best practices; avoid blocking the event loop.
- Use meaningful variable and function names following snake_case (Python) and camelCase (TypeScript).
- Public APIs must have docstrings (Python) or JSDoc (TypeScript) comments.
- All async operations must handle errors gracefully with appropriate try/catch or try/except blocks.

## Project Structure Conventions
- server/: FastAPI application, routers, models, services, database layer, WebSocket handlers.
- client/: React components, PixiJS scenes, Yjs providers, WebRTC connection logic, asset management.
- Keep shared types/interfaces in a common location if both client and server need them.
- Tests should mirror source structure: server/tests/ and client/src/__tests__/.

## Testing Strategy
- Backend: pytest with async support. Mock all database and P2P dependencies.
- Frontend: Unit tests for utilities and hooks. Integration tests for PixiJS scenes where feasible.
- Aim for meaningful coverage on critical paths: CRDT sync, asset transfer, WebSocket signaling.

## Communication Style with Cline
- Speak in Russian for conversational text, but keep technical terms in English (in brackets if needed).
- Be concise and technical — avoid fluff and unnecessary explanations.
- When a task is complex, break it down into smaller tasks and ask for clarification before writing code.
- Present completed work with attempt_completion; do not end with questions or open-ended offers.

## Review and Delivery Expectations
- Every deliverable must be self-contained and buildable independently.
- If a file or module is modified, ensure all imports and references are updated accordingly.
- Before marking a task complete, verify no lint errors, type errors, or broken imports exist.