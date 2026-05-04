const SESSION_FRIENDLY_NAMES = [
  'Spark',
  'Nova',
  'Echo',
  'Drift',
  'Pulse',
  'Atlas',
  'Orbit',
  'Prism',
  'Flux',
  'Ember',
  'Haze',
  'Crest',
  'Bloom',
  'Glow',
  'Tide',
  'Wisp',
  'Aura',
  'Nimbus',
  'Vibe',
  'Zephyr',
  'Fern',
  'Opal',
  'Quartz',
  'Sage',
  'Dusk',
  'Cedar',
  'Flint',
  'Coral',
  'Onyx',
  'Lark',
] as const;

export const DEFAULT_GENERAL_AGENT_SESSION_TITLE = 'General Agent';
export const DEFAULT_CURATOR_AGENT_SESSION_TITLE = 'Curator Agent';

export function generateSessionTitle(creationOrderIndex: number): string {
  if (creationOrderIndex === 0) return DEFAULT_GENERAL_AGENT_SESSION_TITLE;

  const nameIndex = creationOrderIndex - 1;
  if (nameIndex < SESSION_FRIENDLY_NAMES.length) {
    return SESSION_FRIENDLY_NAMES[nameIndex];
  }

  return `Session ${creationOrderIndex + 1}`;
}
