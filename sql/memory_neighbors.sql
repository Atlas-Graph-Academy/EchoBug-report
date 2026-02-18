-- TEMPORARY function for EchoBug Report testing only.
-- Computes TOP_K nearest neighbors using pgvector cosine distance.
-- Safe to drop when no longer needed: DROP FUNCTION echobug_test_neighbors;
--
-- Run this in the Supabase SQL Editor (Dashboard > SQL Editor > New query).

CREATE OR REPLACE FUNCTION echobug_test_neighbors(
  p_user_id UUID,
  p_top_k INT DEFAULT 20
)
RETURNS TABLE(source_id UUID, neighbor_id UUID, similarity FLOAT8)
LANGUAGE sql STABLE
AS $$
  SELECT
    a.id AS source_id,
    b.id AS neighbor_id,
    -- cosine distance <=> returns distance (0 = identical), convert to similarity
    1 - (a.description_embedding <=> b.description_embedding) AS similarity
  FROM memory_new a
  CROSS JOIN LATERAL (
    SELECT b2.id, b2.description_embedding
    FROM memory_new b2
    WHERE b2.user_id = p_user_id
      AND b2.id != a.id
      AND b2.description_embedding IS NOT NULL
    ORDER BY a.description_embedding <=> b2.description_embedding
    LIMIT p_top_k
  ) b
  WHERE a.user_id = p_user_id
    AND a.description_embedding IS NOT NULL;
$$;
