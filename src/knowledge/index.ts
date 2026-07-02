/**
 * Knowledge layer — thin read-only cache for mod-aware observation.
 *
 * Populated by Phase 5 (modpack knowledge indexer), this layer provides
 * structured lookups for recipes, quests, guides, and mod metadata.
 *
 * Until Phase 5 lands, all methods return empty/null — skills MUST
 * degrade gracefully to "unknown", never fabricate data.
 */

// ─── Data types ───────────────────────────────────────────────────────────

export interface RecipeEntry {
  id: string;
  type: string; // "crafting", "smelting", "create:mixing", etc.
  outputItem: string;
  outputCount: number;
  ingredients: Array<{ item: string; count: number }>;
  machine: string | null; // e.g. "minecraft:crafting_table", "create:mechanical_press"
  modId: string;
  source: string;
}

export interface JadeBlockInfo {
  name: string;
  displayName: string;
  modId: string;
  hardness: number;
  harvestTool: string | null;
  harvestLevel: number | null;
  tooltip: string[]; // Jade-style tooltip lines
}

export interface QuestTask {
  id: string;
  title: string;
  description: string;
  completed: boolean;
  dependencies: string[];
}

export interface QuestProgress {
  chapter: string;
  chapterTitle: string;
  activeTasks: QuestTask[];
  completedTasks: number;
  totalTasks: number;
}

export interface QuestNode {
  id: string;
  title: string;
  chapter: string;
  tasks: QuestTask[];
  children: QuestNode[];
}

export interface GuideEntry {
  id: string;
  book: string;
  title: string;
  text: string;
  linkedItems: string[];
  modId: string;
}

export interface ModInfo {
  modId: string;
  displayName: string;
  version: string;
  itemCount: number;
  blockCount: number;
  description: string;
}

// ─── Knowledge provider interface ────────────────────────────────────────

export interface KnowledgeProvider {
  getRecipe(itemId: string): RecipeEntry | null;
  getRecipeUsage(itemId: string): RecipeEntry[];
  getBlockInfo(x: number, y: number, z: number, dimension: string): JadeBlockInfo | null;
  getQuestProgress(): QuestProgress | null;
  getQuestTree(depth?: number): QuestNode | null;
  searchGuide(query: string): GuideEntry[];
  getModInfo(modId: string): ModInfo | null;
}

// ─── Empty provider (Phase 3 default — all queries return empty) ─────────

class EmptyKnowledgeProvider implements KnowledgeProvider {
  getRecipe(_itemId: string): RecipeEntry | null {
    return null;
  }
  getRecipeUsage(_itemId: string): RecipeEntry[] {
    return [];
  }
  getBlockInfo(_x: number, _y: number, _z: number, _dimension: string): JadeBlockInfo | null {
    return null;
  }
  getQuestProgress(): QuestProgress | null {
    return null;
  }
  getQuestTree(_depth?: number): QuestNode | null {
    return null;
  }
  searchGuide(_query: string): GuideEntry[] {
    return [];
  }
  getModInfo(_modId: string): ModInfo | null {
    return null;
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────

let knowledge: KnowledgeProvider = new EmptyKnowledgeProvider();

/**
 * Set the active knowledge provider. Called once during worker init.
 * Phase 5 will replace this with a SQLite-backed provider.
 */
export function setKnowledgeProvider(provider: KnowledgeProvider): void {
  knowledge = provider;
}

/** Get the current knowledge provider (never null). */
export function getKnowledgeProvider(): KnowledgeProvider {
  return knowledge;
}
