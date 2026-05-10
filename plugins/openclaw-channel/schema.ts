export interface OpenClawSkillOutputBundle {
  skillName: string;
  bundleDir: string;
  runTimestamp: string;
  text: string;
  mcpAppHtml: string;
}

export interface OpenClawChannelInput {
  skillName?: string;
  skill?: string | {
    name?: string;
    id?: string;
  };
  name?: string;
  id?: string;
  runTimestamp?: string | number | Date;
  timestamp?: string | number | Date;
  bundleDir?: string;
  outputDir?: string;
  runDir?: string;
}

export interface EvogentSubmitItem {
  id: string;
  type: 'article';
  source: 'openclaw';
  sourceId: string;
  relationship: 'thread';
  title: string;
  text: string;
  authorDisplayName: string;
  publishedAt: string;
  tags: string[];
  metadata: {
    layoutMode: 'agent-session';
    openClaw: {
      skillName: string;
      bundleDir: string;
      runTimestamp: string;
    };
    thread: {
      threadId: string;
      threadTitle: string;
      color: string;
      continuing: true;
    };
    mcpAppHtml: string;
  };
}
