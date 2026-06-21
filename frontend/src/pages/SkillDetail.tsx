import { useParams } from "react-router-dom";
import type { MeResponse } from "../api/client.js";

export function SkillDetail({ user: _user }: { user: MeResponse }) {
  const { id } = useParams<{ id: string }>();
  return (
    <div style={{ padding: "var(--space-6)" }}>
      <h1>Skill Detail (stub)</h1>
      <p>Skill ID: {id}</p>
      <p style={{ color: "var(--text-tertiary)" }}>Full implementation in Task D3</p>
    </div>
  );
}
