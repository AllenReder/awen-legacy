import { createFileRoute } from "@tanstack/react-router";

// A durable Thread is the canonical Agent Session identity.
export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  component: () => null,
});
