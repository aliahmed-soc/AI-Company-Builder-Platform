// core/memory — typed memory public index (ACBP-P2-006; CDR-024). Cross-module imports go through this index.
export {
  createMemoryItem,
  listMemoryItems,
  editMemoryItem,
  getMemoryItem,
  MEMORY_LIST_DEFAULT_LIMIT,
  MEMORY_LIST_MAX_LIMIT,
  type CreateMemoryItemParams,
  type ListMemoryItemsParams,
  type EditMemoryItemParams,
  type GetMemoryItemParams,
  type MemoryOptions,
  type CreateMemoryItemResult,
  type ListMemoryItemsResult,
  type EditMemoryItemResult,
  type GetMemoryItemResult,
} from './memory-item.js';
