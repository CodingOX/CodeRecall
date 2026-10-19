# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Parent / child vs blocking

Parent/child is **ownership** (sub-issue), not a start-gate. Blocking is a separate native edge.

### Write (only with tracker write authorization)

Modern `gh` flags from `gh issue create --help` / `gh issue edit --help` (REST fallback below if a flag is missing):

- Create as a child: `gh issue create --parent <parent-number> --title "..." --body "..."`
- Attach later: `gh issue edit <parent-number> --add-sub-issue <child-number>`
- Native blocked-by: `gh issue create --blocked-by <n>` or `gh issue edit <child> --add-blocked-by <blocker-number>`

`--parent` / `--add-sub-issue` take an **issue number** or URL, not the GraphQL node_id.

Older `gh` without those flags, via REST:

- Sub-issue: `gh api --method POST repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>` where `<child-db-id>` is `gh api repos/<owner>/<repo>/issues/<n> --jq .id` (the numeric **database id**, not the `#number`).
- Blocking: `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`

Do not invent extra `gh issue` subcommands.

### Read-back (required after write)

```bash
gh issue view <n> --json number,id,parent,subIssues,blockedBy
```

`gh issue view --json id` returns the GraphQL node ID; it is **not** the numeric REST database `id`. For REST `sub_issue_id` / `issue_id`, read the numeric value with `gh api repos/<owner>/<repo>/issues/<n> --jq .id`. On read-back, confirm `parent`, `subIssues`, and `blockedBy`; if the installed `gh` cannot query them, keep the body `Blocked by` section as the source of truth and do not claim the native edge was verified.

If native sub-issues or dependencies are unavailable (404/403/unsupported), degrade to body text:

- Child: `Part of #<parent>` at the top
- Blocking: `Blocked by: #<n>` at the top

and mark that body line as the **unique source of truth**. Do not claim native edges exist.

If body text and native edges conflict, stop and verify with the user; do not overwrite tracker edges from the body.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.
