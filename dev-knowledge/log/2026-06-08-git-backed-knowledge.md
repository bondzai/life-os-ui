---
type: log
tags: [decision, architecture]
date: 2026-06-08
updated: 2026-06-08
---

# Git-backed knowledge store

## What

Store the knowledge module as plain markdown files in a git repo, edited through the API.

## Why

Plain text survives the app. Git gives free history + diffs. No new database tables.

## What Changed

Added `api/src/routes/knowledge.ts` and a Knowledge page with persona/context/agents/log/search/history tabs.
