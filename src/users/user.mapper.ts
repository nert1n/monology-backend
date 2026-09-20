import {
  InterfaceLanguage,
  UserSex,
  type User,
} from '../../generated/prisma/index.js';
import {
  computeAge,
  formatDateOnly,
} from './lib/date-of-birth.js';
import {
  readProfileColors,
  type ProfileColors,
} from './lib/profile-colors.js';

export type PublicUser = {
  id: string;
  email: string;
  username: string;
  displayName: string;
  bio: string;
  avatarUrl: string | null;
  profileBackgroundUrl: string | null;
  profileHidden: boolean;
  profileColors: ProfileColors | null;
  websiteUrl: string | null;
  sex: UserSex;
  /** ISO date YYYY-MM-DD; private (owner /admin only). */
  dateOfBirth: string | null;
  displayAge: boolean;
  displayAdultContent: boolean;
  interfaceLanguage: InterfaceLanguage;
  googleConnected: boolean;
  role: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe fields for public profile GET — no email, DOB, prefs, or Google id. */
export type PublicProfile = {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  avatarUrl: string | null;
  profileBackgroundUrl: string | null;
  profileHidden: boolean;
  profileColors: ProfileColors | null;
  websiteUrl: string | null;
  /** Null when unset / prefer not to say. */
  sex: Exclude<UserSex, 'PREFER_NOT_TO_SAY'> | null;
  /** Computed age when displayAge is on and DOB is set; otherwise null. */
  age: number | null;
  role: string;
  createdAt: Date;
  updatedAt: Date;
};

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    avatarUrl: user.avatarUrl,
    profileBackgroundUrl: user.profileBackgroundUrl,
    profileHidden: user.profileHidden,
    profileColors: readProfileColors(user.profileColors),
    websiteUrl: user.websiteUrl,
    sex: user.sex,
    dateOfBirth: user.dateOfBirth ? formatDateOnly(user.dateOfBirth) : null,
    displayAge: user.displayAge,
    displayAdultContent: user.displayAdultContent,
    interfaceLanguage: user.interfaceLanguage,
    googleConnected: Boolean(user.googleId),
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export function toPublicProfile(user: User): PublicProfile {
  const sex =
    user.sex === UserSex.PREFER_NOT_TO_SAY
      ? null
      : (user.sex as Exclude<UserSex, 'PREFER_NOT_TO_SAY'>);

  const age =
    user.displayAge && user.dateOfBirth
      ? computeAge(user.dateOfBirth)
      : null;

  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    avatarUrl: user.avatarUrl,
    profileBackgroundUrl: user.profileBackgroundUrl,
    profileHidden: user.profileHidden,
    profileColors: readProfileColors(user.profileColors),
    websiteUrl: user.websiteUrl,
    sex,
    age,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
