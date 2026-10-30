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
    maxItems: number;
    minScore: number;
    conflictPenalty: number;
    /** Print the tone an event was spoken in, when it was not neutral (Q64). */
    toneHint: boolean;
    layerPenalty: {
      fact: number;
      event: number;
      subjective: number;
      l0: number;
    };
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
/** A resolved reference: `E37` / `F12` / `D3` / `T`. */
declare type Ref = {
    kind: "event" | "fact" | "doc" | "tail";
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
declare function sliceByTokens(text: string, offset: number, budget: number): {
    piece: string;
    end: number;
    done: boolean;
};
declare function estimateTokens(text: string): number;
//#endregion
export { Config, apply, inject, name, HookIndex, indexDefaults, estimateTokens, parseRef, sliceByTokens };