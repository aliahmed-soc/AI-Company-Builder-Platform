// core/memory — typed memory public index (ACBP-P2-006; CDR-024). Cross-module imports go through this index.
export {
  createMemoryItem,
  listMemoryItems,
  MEMORY_LIST_DEFAULT_LIMIT,
  MEMORY_LIST_MAX_LIMIT,
  type CreateMemoryItemParams,
  type ListMemoryItemsParams,
  type MemoryOptions,
  type CreateMemoryItemResult,
  type ListMemoryItemsResult,
} from './memory-item.js';
