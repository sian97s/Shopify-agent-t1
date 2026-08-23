import type { Db } from './infra/db.js';
import { openDb } from './infra/db.js';
import { config as defaultConfig, type Config } from './infra/config.js';
import { systemClock, type Clock } from './infra/clock.js';
import { LocalDiskStorage, type ObjectStorage } from './services/storage/index.js';
import { createAiProvider } from './services/ai/index.js';
import type { AiProvider } from './services/ai/types.js';
import { ArtworkRepository } from './domain/artwork/repository.js';
import { ArtKeyService, loadPepper } from './domain/artkey/service.js';
import { OwnershipService } from './domain/ownership/index.js';
import { GravityService } from './domain/gravity/index.js';
import { RelationshipService } from './domain/relationships/index.js';
import { DiscoveryService } from './domain/discovery/index.js';
import { SearchService } from './domain/search/index.js';
import { ReactionService } from './domain/reactions/index.js';
import { ReportingService } from './domain/reporting/index.js';
import { AnalyticsService } from './domain/analytics/index.js';
import { EvolutionEngine } from './domain/experiments/index.js';
import { UploadSessionService } from './domain/upload-session/service.js';
import { ModerationPipeline } from './domain/moderation/pipeline.js';
import { IntakeService } from './domain/moderation/intake.js';
import { DEFAULT_KDF, type KdfParams } from './domain/artkey/hashing.js';

export interface AppContext {
  config: Config;
  db: Db;
  clock: Clock;
  storage: ObjectStorage;
  ai: AiProvider;
  artworks: ArtworkRepository;
  artKeys: ArtKeyService;
  ownership: OwnershipService;
  gravity: GravityService;
  relationships: RelationshipService;
  discovery: DiscoveryService;
  search: SearchService;
  reactions: ReactionService;
  reporting: ReportingService;
  analytics: AnalyticsService;
  evolution: EvolutionEngine;
  sessions: UploadSessionService;
  intake: IntakeService;
}

export interface ContextOverrides {
  config?: Partial<Config>;
  clock?: Clock;
  ai?: AiProvider;
  storage?: ObjectStorage;
  kdf?: KdfParams;
  db?: Db;
}

/**
 * Composition root. Every domain is constructed here and nowhere else, so the
 * dependency direction stays one-way and tests can swap the clock, the AI
 * provider or the storage driver without touching domain code.
 */
export function createContext(overrides: ContextOverrides = {}): AppContext {
  const config = { ...defaultConfig, ...overrides.config };
  const db = overrides.db ?? openDb(config.dbFile);
  const clock = overrides.clock ?? systemClock;
  const storage = overrides.storage ?? new LocalDiskStorage(config.mediaDir);
  const ai =
    overrides.ai ??
    createAiProvider({
      anthropicApiKey: config.anthropicApiKey,
      anthropicModel: config.anthropicModel
    });

  const artworks = new ArtworkRepository(db);
  const artKeys = new ArtKeyService(db, loadPepper(config.dataDir), clock, overrides.kdf ?? DEFAULT_KDF);
  const ownership = new OwnershipService(db);
  const gravity = new GravityService(db, config.gravityHalfLifeMs, clock);
  const relationships = new RelationshipService(db);
  const discovery = new DiscoveryService(gravity, clock);
  const search = new SearchService(db, artworks, discovery);
  const reactions = new ReactionService(db, gravity);
  const reporting = new ReportingService(db);
  const analytics = new AnalyticsService(db, clock);
  const evolution = new EvolutionEngine(db, analytics, clock);
  const sessions = new UploadSessionService(
    db,
    { ttlMs: config.uploadSessionTtlMs, graceMs: config.uploadSessionGraceMs },
    clock
  );
  const pipeline = new ModerationPipeline(ai);
  const intake = new IntakeService(db, {
    sessions, pipeline, artworks, artKeys, relationships, gravity,
    storage, tmpDir: config.tmpDir, clock
  });

  return {
    config, db, clock, storage, ai, artworks, artKeys, ownership, gravity,
    relationships, discovery, search, reactions, reporting, analytics,
    evolution, sessions, intake
  };
}
