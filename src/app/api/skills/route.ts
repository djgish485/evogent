import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { getSkillsRegistry, listInstalledSkillsWithWarnings } from '@/lib/skills';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { items: skills, skipped } = await listInstalledSkillsWithWarnings();
    const installedSlugs = new Set(skills.map((skill) => skill.slug));
    const feedSources = skills
      .flatMap((skill) => {
        const metadata = skill.metadata?.['evogent'];
        const value = metadata?.['feed-source'];
        if (typeof value !== 'string') {
          return [];
        }
        const label = typeof metadata?.['feed-source-label'] === 'string'
          ? metadata['feed-source-label']
          : value;

        return { value, label };
      });
    const openClawHome = process.env.OPENCLAW_HOME || path.join(homedir(), '.openclaw');
    const openClawChannelPath = path.join(openClawHome, 'channels', 'evogent');

    try {
      await access(openClawChannelPath);
      feedSources.push({ value: 'openclaw', label: 'OpenClaw' });
    } catch {
      // Missing OpenClaw channel install is expected.
    }

    return NextResponse.json({
      items: skills,
      total: skills.length,
      active: skills.filter((skill) => skill.active).length,
      registry: getSkillsRegistry(installedSlugs),
      feedSources,
      skippedSkills: skipped.map((skill) => ({
        slug: skill.slug,
        error: skill.error,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load skills' },
      { status: 500 },
    );
  }
}
