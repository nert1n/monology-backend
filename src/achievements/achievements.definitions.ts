export type AchievementDefinition = {
  code: string;
  title: string;
  description: string;
  sortOrder: number;
};

/** Seeded achievement catalog. Unlock rules live in AchievementsService. */
export const ACHIEVEMENT_DEFINITIONS: AchievementDefinition[] = [
  {
    code: 'first_item',
    title: 'First Entry',
    description: 'Add your first item to a shelf.',
    sortOrder: 10,
  },
  {
    code: 'items_10',
    title: 'Collector',
    description: 'Reach 10 items across your lists.',
    sortOrder: 20,
  },
  {
    code: 'items_50',
    title: 'Archivist',
    description: 'Reach 50 items across your lists.',
    sortOrder: 30,
  },
  {
    code: 'profile_complete',
    title: 'Persona Ready',
    description: 'Set a display name, bio, and avatar.',
    sortOrder: 40,
  },
  {
    code: 'first_friend',
    title: 'Social Shelf',
    description: 'Make your first friend.',
    sortOrder: 50,
  },
  {
    code: 'club_member',
    title: 'Club Mate',
    description: 'Join or create a club.',
    sortOrder: 60,
  },
];
