import { NextResponse } from 'next/server';
import {
  getActionsForSkill,
  getSkillActionRegistrySnapshot,
} from '@/lib/feed-actions/skill-action-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const skill = searchParams.get('skill')?.trim().toLowerCase() || '';

  if (skill) {
    return NextResponse.json({
      ok: true,
      skill,
      actions: getActionsForSkill(skill),
    });
  }

  return NextResponse.json({
    ok: true,
    registry: getSkillActionRegistrySnapshot(),
  });
}
