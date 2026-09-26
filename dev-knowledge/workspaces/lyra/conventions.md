---
type: knowledge
order: 1
updated: 2026-09-26
---

# Conventions that are not obvious from the code

**Comments carry the history.** Most comments in this repo record a decision or a bug that was
actually made. They are dense on purpose. A comment restating the code is noise; a comment
explaining why the obvious approach was wrong is the most valuable thing in the file.

**Tests are named as rules.** `an_idle_desk_still_says_what_it_last_did`, not `test_agent_2`. When a
bug is fixed, the test name is the rule the bug broke.

**One entities table.** Every type — task, note, goal, workspace — is a row in `entities`, with
type-specific fields in a `metadata` JSON blob. Do not add a table for a new entity type.

**The list of settings the service receives lives in exactly one file**, `ops/service-env.list`,
because it used to live in two and one of them fell behind. A test reads it and fails naming the
variable and its source file.
