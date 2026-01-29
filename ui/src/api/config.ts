import { apiFetchJson } from './http';

export type ProfilesResponse = {
  delayProfiles: string[];
  typingProfiles: string[];
};

export const ConfigApi = {
  profiles: () => apiFetchJson<ProfilesResponse>('/config/profiles'),
};
