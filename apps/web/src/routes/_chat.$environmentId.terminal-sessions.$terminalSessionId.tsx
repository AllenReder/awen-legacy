import { createFileRoute } from "@tanstack/react-router";

// A durable Terminal Session is addressed by Environment and its stable
// identity; its Workspace assignment is mutable metadata, not routing state.
export const Route = createFileRoute("/_chat/$environmentId/terminal-sessions/$terminalSessionId")({
  component: () => null,
});
