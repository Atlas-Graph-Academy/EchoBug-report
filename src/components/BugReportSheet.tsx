'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import type { CreatedIssue } from '@/lib/types';
import { useLinearData } from '@/hooks/useLinearData';
import { uploadImageToLinear, linearGraphQL } from '@/lib/linear';

const PRIORITIES = [
  { value: 0, label: 'None' },
  { value: 1, label: 'Urgent' },
  { value: 2, label: 'High' },
  { value: 3, label: 'Medium' },
  { value: 4, label: 'Low' },
];

interface BugReportSheetProps {
  annotatedBlob: Blob;
  previewUrl: string;
  getAccessToken: () => string | null;
  onClose: () => void;
  onSuccess: (issue: CreatedIssue) => void;
}

export default function BugReportSheet({
  annotatedBlob,
  previewUrl,
  getAccessToken,
  onClose,
  onSuccess,
}: BugReportSheetProps) {
  const [open, setOpen] = useState(false);
  const { teams, teamsLoading, fetchTeams, teamDetails, detailsLoading, fetchTeamDetails } =
    useLinearData(getAccessToken);

  const [teamId, setTeamId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [stateId, setStateId] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [priority, setPriority] = useState(0);
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Animate open
  useEffect(() => {
    requestAnimationFrame(() => setOpen(true));
    fetchTeams();
  }, [fetchTeams]);

  // Auto-select first team
  useEffect(() => {
    if (teams.length > 0 && !teamId) {
      setTeamId(teams[0].id);
    }
  }, [teams, teamId]);

  // Fetch team details when team changes
  useEffect(() => {
    if (teamId) {
      fetchTeamDetails(teamId);
      setProjectId('');
      setStateId('');
      setAssigneeId('');
      setLabelIds([]);
    }
  }, [teamId, fetchTeamDetails]);

  const currentDetails = teamDetails[teamId];

  // Auto-select default state (first "unstarted" or "backlog" type)
  useEffect(() => {
    if (currentDetails?.states && !stateId) {
      const backlog = currentDetails.states.find((s) => s.type === 'backlog');
      const unstarted = currentDetails.states.find((s) => s.type === 'unstarted');
      const defaultState = backlog || unstarted || currentDetails.states[0];
      if (defaultState) setStateId(defaultState.id);
    }
  }, [currentDetails?.states, stateId]);

  const toggleLabel = (id: string) => {
    setLabelIds((prev) => (prev.includes(id) ? prev.filter((l) => l !== id) : [...prev, id]));
  };

  const handleClose = useCallback(() => {
    setOpen(false);
    setTimeout(onClose, 350);
  }, [onClose]);

  const handleSubmit = async () => {
    if (!title.trim() || !teamId) return;
    const token = getAccessToken();
    if (!token) return;

    setSubmitting(true);
    setError('');

    try {
      // Upload image
      const assetUrl = await uploadImageToLinear(
        token,
        annotatedBlob,
        `echobug-${Date.now()}.jpg`
      );

      // Build description with embedded image
      const fullDescription = [
        description.trim(),
        '',
        `![Screenshot](${assetUrl})`,
      ]
        .filter((line, i) => i > 0 || line)
        .join('\n');

      // Create issue
      const variables: Record<string, unknown> = {
        title: title.trim(),
        description: fullDescription,
        teamId,
        priority,
      };
      if (projectId) variables.projectId = projectId;
      if (stateId) variables.stateId = stateId;
      if (assigneeId) variables.assigneeId = assigneeId;
      if (labelIds.length > 0) variables.labelIds = labelIds;

      const data = await linearGraphQL<{
        issueCreate: {
          success: boolean;
          issue: { id: string; identifier: string; url: string; title: string };
        };
      }>(
        token,
        `mutation(
          $title: String!,
          $description: String,
          $teamId: String!,
          $priority: Int,
          $projectId: String,
          $stateId: String,
          $assigneeId: String,
          $labelIds: [String!]
        ) {
          issueCreate(input: {
            title: $title,
            description: $description,
            teamId: $teamId,
            priority: $priority,
            projectId: $projectId,
            stateId: $stateId,
            assigneeId: $assigneeId,
            labelIds: $labelIds
          }) {
            success
            issue { id identifier url title }
          }
        }`,
        variables
      );

      if (data.issueCreate.success) {
        onSuccess(data.issueCreate.issue);
      } else {
        setError('Failed to create issue.');
      }
    } catch (err) {
      console.error('Submit error:', err);
      setError(err instanceof Error ? err.message : 'Failed to create issue.');
    } finally {
      setSubmitting(false);
    }
  };

  // Sort states by type order
  const sortedStates = useMemo(() => {
    if (!currentDetails?.states) return [];
    const typeOrder = ['backlog', 'unstarted', 'started', 'completed', 'cancelled'];
    return [...currentDetails.states].sort(
      (a, b) => typeOrder.indexOf(a.type) - typeOrder.indexOf(b.type)
    );
  }, [currentDetails?.states]);

  return (
    <>
      <div className={`sheet-backdrop${open ? ' open' : ''}`} onClick={handleClose} />
      <div className={`bug-report-sheet${open ? ' open' : ''}`}>
        <div className="sheet-handle" />
        <div className="sheet-header">
          <h2>New Issue</h2>
          <button className="sheet-close" onClick={handleClose}>
            &times;
          </button>
        </div>

        <div className="sheet-body">
          {/* Image preview */}
          <div className="sheet-preview">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewUrl} alt="Annotated screenshot" />
          </div>

          {/* Title */}
          <div className="field-group">
            <label className="field-label">Title *</label>
            <input
              className="field-input"
              type="text"
              placeholder="Bug title..."
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </div>

          {/* Description */}
          <div className="field-group">
            <label className="field-label">Description</label>
            <textarea
              className="field-textarea"
              placeholder="Describe the bug..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {/* Team */}
          <div className="field-group">
            <label className="field-label">Team *</label>
            <select
              className="field-select"
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
              disabled={teamsLoading}
            >
              {teamsLoading && <option>Loading...</option>}
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>

          {/* Project */}
          {currentDetails?.projects && currentDetails.projects.length > 0 && (
            <div className="field-group">
              <label className="field-label">Project</label>
              <select
                className="field-select"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                disabled={detailsLoading}
              >
                <option value="">No project</option>
                {currentDetails.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Status */}
          {sortedStates.length > 0 && (
            <div className="field-group">
              <label className="field-label">Status</label>
              <select
                className="field-select"
                value={stateId}
                onChange={(e) => setStateId(e.target.value)}
              >
                {sortedStates.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Priority */}
          <div className="field-group">
            <label className="field-label">Priority</label>
            <div className="priority-chips">
              {PRIORITIES.map((p) => (
                <button
                  key={p.value}
                  className={`priority-chip${priority === p.value ? ' active' : ''}`}
                  onClick={() => setPriority(p.value)}
                  type="button"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Assignee */}
          {currentDetails?.members && currentDetails.members.length > 0 && (
            <div className="field-group">
              <label className="field-label">Assignee</label>
              <select
                className="field-select"
                value={assigneeId}
                onChange={(e) => setAssigneeId(e.target.value)}
              >
                <option value="">Unassigned</option>
                {currentDetails.members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName || m.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Labels */}
          {currentDetails?.labels && currentDetails.labels.length > 0 && (
            <div className="field-group">
              <label className="field-label">Labels</label>
              <div className="label-chips">
                {currentDetails.labels.map((l) => (
                  <button
                    key={l.id}
                    className={`label-chip${labelIds.includes(l.id) ? ' active' : ''}`}
                    onClick={() => toggleLabel(l.id)}
                    type="button"
                  >
                    <span className="label-dot" style={{ backgroundColor: l.color }} />
                    {l.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Error */}
          {error && <div className="login-error">{error}</div>}

          {/* Submit */}
          <button
            className="submit-btn"
            onClick={handleSubmit}
            disabled={!title.trim() || !teamId || submitting}
          >
            {submitting ? (
              <>
                <div className="login-spinner" /> Creating...
              </>
            ) : (
              'Create Issue'
            )}
          </button>
        </div>
      </div>
    </>
  );
}
