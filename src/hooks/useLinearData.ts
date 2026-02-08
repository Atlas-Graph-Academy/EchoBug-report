'use client';

import { useState, useCallback, useRef } from 'react';
import type { LinearTeam, LinearProject, LinearState, LinearMember, LinearLabel } from '@/lib/types';
import { linearGraphQL } from '@/lib/linear';

interface TeamDetails {
  projects: LinearProject[];
  states: LinearState[];
  members: LinearMember[];
  labels: LinearLabel[];
}

export function useLinearData(getAccessToken: () => string | null) {
  const [teams, setTeams] = useState<LinearTeam[]>([]);
  const [teamsLoading, setTeamsLoading] = useState(false);
  const teamDetailsCache = useRef<Record<string, TeamDetails>>({});
  const [teamDetails, setTeamDetails] = useState<Record<string, TeamDetails>>({});
  const [detailsLoading, setDetailsLoading] = useState(false);

  const fetchTeams = useCallback(async () => {
    const token = getAccessToken();
    if (!token) return;
    setTeamsLoading(true);
    try {
      const data = await linearGraphQL<{ teams: { nodes: LinearTeam[] } }>(
        token,
        `{ teams { nodes { id name key } } }`
      );
      setTeams(data.teams.nodes);
    } catch (err) {
      console.error('Failed to fetch teams:', err);
    } finally {
      setTeamsLoading(false);
    }
  }, [getAccessToken]);

  const fetchTeamDetails = useCallback(
    async (teamId: string) => {
      if (teamDetailsCache.current[teamId]) {
        setTeamDetails((prev) => ({ ...prev, [teamId]: teamDetailsCache.current[teamId] }));
        return;
      }

      const token = getAccessToken();
      if (!token) return;
      setDetailsLoading(true);

      try {
        const data = await linearGraphQL<{
          team: {
            projects: { nodes: LinearProject[] };
            states: { nodes: LinearState[] };
            members: { nodes: LinearMember[] };
            labels: { nodes: LinearLabel[] };
          };
        }>(
          token,
          `query($teamId: String!) {
            team(id: $teamId) {
              projects { nodes { id name } }
              states { nodes { id name type color } }
              members { nodes { id name displayName avatarUrl } }
              labels { nodes { id name color } }
            }
          }`,
          { teamId }
        );

        const details: TeamDetails = {
          projects: data.team.projects.nodes,
          states: data.team.states.nodes,
          members: data.team.members.nodes,
          labels: data.team.labels.nodes,
        };

        teamDetailsCache.current[teamId] = details;
        setTeamDetails((prev) => ({ ...prev, [teamId]: details }));
      } catch (err) {
        console.error('Failed to fetch team details:', err);
      } finally {
        setDetailsLoading(false);
      }
    },
    [getAccessToken]
  );

  return {
    teams,
    teamsLoading,
    fetchTeams,
    teamDetails,
    detailsLoading,
    fetchTeamDetails,
  };
}
