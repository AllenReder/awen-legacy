# Workspace assignment owns Agent execution context

**Status: accepted**

An Agent Session's committed Workspace is the authority for its directory. Git HEAD describes that directory, while an Execution Plan describes an uncommitted next turn. Previously, a nullable Thread worktree path and a persisted composer draft could disagree after a move to the main checkout: the Sidebar followed the committed assignment while the branch picker followed the old draft. Session branch selection now resolves the registered Workspace on the server and chooses between a Git checkout there and a Session migration to another registered checkout. New worktree setup names its source Workspace, so the server resolves the directory and ownership without accepting a client supplied path. Provider relocation, assignment commit, and recovery remain one Session operation; the client retains only the next turn's editing plan.
