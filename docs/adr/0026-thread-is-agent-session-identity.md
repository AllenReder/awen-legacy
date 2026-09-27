# Use the durable Thread as the Agent Session identity

**Status: accepted (supersedes the Agent link in ADR-0003 and Agent identity and close policy in ADR-0016)**

A newly created Agent Session is an ordinary durable Thread, even before its first message. The Thread ID addresses its Sidebar entry, deep link, and unique Workbench Pane; its Workspace assignment and provider-native session binding may change without changing that address. Closing the Pane preserves the Session, including an empty one; explicit Archive archives it and explicit Delete removes it. This removes the separate Agent Session ID and draft View promotion that made first send or a Workspace move replace the conversation's presentation, while retaining ADR-0016's drag behavior.

The canonical Agent link is `/{environmentId}/{threadId}`. The former Workspace-scoped Agent link and draft link are removed during the alpha contract reset; Terminal links retain their Workspace scope.
