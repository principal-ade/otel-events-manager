# Registry Sync

The registry sync flow handles workspace registration for trace matching.

## Overview

When a workspace is synced via `POST /api/registry/sync`:

1. **Start** - Parse sync request (update or remove action)
2. **Register** - For updates, register workspace with RegistryManager
3. **Discover** - Discover and load dashboard definitions
4. **Complete** - Persist to database and notify UI

## Actions

### Update
Registers or updates a workspace:
- Validates FileTree is present
- Populates InMemoryFileSystemAdapter with relevant files
- Registers with LocalRegistry for scope discovery
- Discovers `.dashboard.json` files
- Stores workspace metadata in SQLite

### Remove
Deactivates a workspace:
- Removes from RegistryManager
- Marks as inactive in database
- Notifies UI via RPC

## Key Components

- **RegistryManager** (`src/bun/index.ts:1003`) - Manages LocalRegistry wrapper
- **LocalRegistry** - From @principal-ai/principal-view-core, handles scope registration
- **MetricsIngestionService** - Receives dashboard definitions for metrics aggregation
