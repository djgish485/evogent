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
