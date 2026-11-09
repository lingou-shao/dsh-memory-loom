import * as _deepseek_ai_schemastery0 from "@deepseek-ai/schemastery";
import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";

//#region src/config.d.ts

/** The validated plugin configuration. */
interface Config$1 {
  /** SQLite file, or `:memory:` for an ephemeral store. */
  path: string;
  /** How the owner is called in the persona and in audit entries. */
  ownerName: string;
  /** Language of the rendered memory block. */
  locale: 'zh' | 'en';
  /** IANA zone for dates and day boundaries; empty means the host's zone. */
  timezone: string;
  /** Capture every user/assistant turn into L0. */
  capture: boolean;
  /** Prefix every tool name carries; set to `loom_` to run beside another memory plugin. */
  toolPrefix: string;
  /** Raw-turn storage policy. */
  l0: {
    /** Per-message cap in characters; `0` stores the message verbatim. */
    maxCharsPerMessage: number;
  };
  /** Background pass interval, in seconds. */
  maintenanceIntervalSeconds: number;
  /** Consolidation policy. */
  consolidation: {
    enabled: boolean;
    /** Provider route for consolidation calls; empty means "reuse the session's route". */
    provider: string;
    /** Model id for consolidation calls; empty means "reuse the session's route". */
    model: string;
    triggerTokens: number;
    idleMinutes: number;
    maxRunSeconds: number;
    itemTimeoutSeconds: number;
    dailyLlmCalls: number;
    sampleK: number;
    sampleM: number;
    coldStartFacts: number;
    diaryPerDay: number;
    narrativeEvidence: number;
    retries: number;
    dlqItems: number;
    dlqDays: number;
  };
  /** Event segmentation thresholds. */
  segmentation: {
    gapMinutes: number;
    hardTopicJaccard: number;
    softSalience: number;
    softDelta: number;
    microTopicJaccard: number;
    microSalience: number;
    minSecondary: number;
  };
  /** Retention curve. */
  decay: {
    d: number;
    sInitial: number;
    sMaxMultiplier: number;
    floor: number;
    retrievalBoost: number;
    expiryHalfLifeDays: number;
  };
  /** Emotion weighting. */
  emotion: {
    l1Weight: number;
    subjectiveWeight: number;
    boost: number;
  };
  /** Recall and the memory block. */
  retrieval: {
    budgetTokens: number;
    hardCapTokens: number;
    subjectiveShare: number;
    /** Facts and events only; subjective rows are budgeted downstream (v0.2.19). */
    maxItems: number;
    minScore: number;
    conflictPenalty: number;
    /** How many recent standing preferences ride along on every turn (v0.2.15). */
    residentPreferences: number;
    /** How many plans ride along on every turn, independent of the query (v0.2.19). */
    maxPlans: number;
    /**
     * Days between two asks about the same unanswered plan (v0.2.23).
     *
     * The first ask is immediate, at the deadline. An unanswered plan stays in
     * the zone until `memory_resolve` gives it an outcome; this only bounds how
     * often the block asks. `0` restores ask-once.
     */
    planNudgeDays: number;
    /** Share of the subjective budget the diary keeps for itself (v0.2.15). */
    diaryShare: number;
    /** Below this confidence, facts not written by hand render as "unconfirmed" (v0.2.15). */
    unconfirmedBelow: number;
    /** Print the tone an event was spoken in, when it was not neutral (Q64). */
    toneHint: boolean;
    /**
     * Lead a fact hit with the verbatim sentence it was extracted from (v0.2.34).
     *
     * Both strings print: the quote is evidence, the summary is the index entry.
     * Unverified quotes are never printed. `false` restores the 0.2.33 line
     * exactly, which is what a rollback and an A/B run need.
     */
    quoteInSearch: boolean;
    /**
     * Search the raw turns as a fallback, and return a pointer to the exchange
     * instead of a summary (v0.2.37).
     *
     * Everything else searches what the extractor made of a turn. On
     * chat-memory-bench that layer located the evidence turn for 23 of 62
     * questions; searching `l0` directly located 55. The hit is a short preview
     * plus an `#L` ref the caller expands — the transcript is never dumped into
     * the result. Runs only when the item pass came back thin, and never on a
     * cross-identity query. `false` restores the 0.2.36 result exactly.
     */
    rawSearch: boolean;
    /** How many raw-turn hits one search may add (v0.2.37). `0` turns the channel off. */
    rawHits: number;
    /** Characters of the matched turn shown before the pointer (v0.2.37). */
    rawPreview: number;
    /**
     * How many (subject, attr) facts may ride in the memory block (v0.2.32).
     *
     * A cap on a chain, not on a list of guesses: the newest values win and
     * the oldest fall off. `memory_search` is not bound by it — it takes the
     * caller's limit. `0` turns the slot channel off.
     */
    slotMax: number;
    /** Similarity a slot hit is scored with; kept under 1 so a lexical hit still leads (v0.2.32). */
    slotSimilarity: number;
    layerPenalty: {
      fact: number;
      event: number;
      subjective: number;
      l0: number;
    };
  };
  /** Rolling local snapshots of the store (v0.2.15). */
  backup: {
    enabled: boolean;
    keep: number;
    everyHours: number;
    dir: string;
  };
  /** Role policy. */
  roles: {
    visitorPurgeHours: number;
    pendingDeleteDays: number;
    promotionVisits: number;
    demotionDays: number;
  };
  /** Privacy of cross-identity queries. */
  privacy: {
    masterCrossIdentity: boolean;
  };
  /** Prompt placement orders (Q65). */
  prompt: {
    personaOrder: number;
    protocolOrder: number;
    memoryOrder: number;
  };
  /** Readable diary mirror (Q63): the diary is never weighted, so it is exported instead. */
  diary: {
    /** Write one Markdown file per day next to the database. */
    mirror: boolean;
    /** Mirror folder; relative values resolve against the database's own folder. */
    mirrorDir: string;
    /** How many of the newest day files to (re)write at load time. */
    mirrorDays: number;
  };
}
/** The schemastery schema the harness validates at load time. */
declare const Config$1: z<Config$1>;
//#endregion
//#region src/index.d.ts

/** Plugin display name, as shown in loader diagnostics. */
declare const name = "memory-loom";
/** Services this plugin needs before `apply` runs. */
declare const inject: string[];
/** Validated configuration schema. */
declare const Config: _deepseek_ai_schemastery0.default<Config$1>;
/**
 * Install the plugin.
 * @param ctx - plugin context.
 * @param config - validated plugin config.
 */
declare function apply(ctx: Context, config: Config$1): void;
//#endregion
//#region src/index-layer.d.ts

/** Defaults for the hook-index layer (single-sourced into the config schema). */
declare const indexDefaults: {
    hooksBudgetTokens: number;
    maxHooks: number;
    minHookScore: number;
    expandBudgetTokens: number;
    maxCharsPerPack: number;
    rebuildMinutes: number;
    coldDays: number;
    includeAssistant: boolean;
};
/** A resolved reference: `E37` / `F12` / `P3` / `D3` / `T`. */
declare type Ref = {
    kind: "event" | "fact" | "preference" | "doc" | "tail";
    id: number;
};
/** Read-mostly hook index over the store this plugin owns. */
declare class HookIndex {
    db: unknown;
    config: Record<string, unknown>;
    now: () => number;
    constructor(db: unknown, config: Record<string, unknown>, now?: () => number);
    identityOf(sessionId: string): string | null;
    rebuild(identityId: string): {
        resident: number;
        candidates: number;
        tokens: number;
    };
    render(identityId: string): string;
    refAlive(key: string): boolean;
    orphanDocs(identityId: string): {
        ref: string;
        doc_id: number;
        title: string;
    }[];
    gc(identityId: string): {
        ref: string;
        doc_id: number;
        title: string;
    }[];
    body(identityId: string, ref: string): {
        ok: false;
        reason: string;
    } | {
        ok: true;
        label: string;
        kind: string;
        text: string;
        chars: number;
        at: number | null;
        summary?: string;
    };
    pack(input: {
        identityId: string;
        ref?: string;
        title: string;
        text: string;
    }): {
        id: number;
        chars: number;
        tokens: number;
        linked: boolean;
        droppedTail: boolean;
    };
    noteAccess(identityId: string, ref: string): void;
}
declare function parseRef(raw: string): Ref | null;
/** A deadline as an interval; `precision` says how much to trust the edges. */
interface DueWindow {
    kind: "absolute" | "relative";
    from: number;
    to: number;
    precision: "day" | "week" | "month" | "fuzzy";
    phrase: string;
}
declare function parseDue(text: string, baseTs: number, timeZone: string | null): DueWindow | undefined;
declare function sliceByTokens(text: string, offset: number, budget: number): {
    piece: string;
    end: number;
    done: boolean;
};
declare function estimateTokens(text: string): number;
//#endregion
export { Config, apply, inject, name, HookIndex, indexDefaults, estimateTokens, parseDue, parseRef, sliceByTokens };