export interface LinearTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  saved_at: number;
}

export interface LinearUser {
  id: string;
  name: string;
  email: string;
  displayName: string;
  avatarUrl: string;
}

export interface LinearTeam {
  id: string;
  name: string;
  key: string;
}

export interface LinearProject {
  id: string;
  name: string;
}

export interface LinearState {
  id: string;
  name: string;
  type: string;
  color: string;
}

export interface LinearMember {
  id: string;
  name: string;
  displayName: string;
  avatarUrl: string;
}

export interface LinearLabel {
  id: string;
  name: string;
  color: string;
}

export interface Photo {
  id?: number;
  name: string;
  dataUrl: string;
  createdAt: number;
}

export interface Stroke {
  color: string;
  size: number;
  points: { x: number; y: number }[];
}

export interface CreatedIssue {
  id: string;
  identifier: string;
  url: string;
  title: string;
}
