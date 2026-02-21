-- Wrapped functions in PUBLIC schema to access waitlist data
-- This avoids the need to expose the 'waitlist' schema in API settings

CREATE OR REPLACE FUNCTION public.get_waitlist_data(
    p_status text DEFAULT 'all',
    p_search text DEFAULT '',
    p_page int DEFAULT 1,
    p_page_size int DEFAULT 20
)
RETURNS TABLE (
    id uuid,
    name text,
    email text,
    status text,
    created_at timestamptz,
    how_did_you_hear text,
    message text,
    invitation_code text,
    invitation_sent_at timestamptz,
    total_count bigint
)
SECURITY DEFINER
AS $$
DECLARE
    v_offset int;
    v_total bigint;
BEGIN
    v_offset := (p_page - 1) * p_page_size;

    SELECT COUNT(*) INTO v_total
    FROM waitlist.signups s
    WHERE
        (p_status = 'all' OR s.status = p_status)
        AND (p_search = '' OR s.name ILIKE '%' || p_search || '%' OR s.email ILIKE '%' || p_search || '%');

    RETURN QUERY
    SELECT
        s.id, s.name, s.email, s.status, s.created_at, s.how_did_you_hear, s.message, s.invitation_code, s.invitation_sent_at,
        v_total
    FROM waitlist.signups s
    WHERE
        (p_status = 'all' OR s.status = p_status)
        AND (p_search = '' OR s.name ILIKE '%' || p_search || '%' OR s.email ILIKE '%' || p_search || '%')
    ORDER BY s.created_at DESC
    LIMIT p_page_size OFFSET v_offset;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.update_waitlist_status(
    p_ids uuid[],
    p_status text
)
RETURNS void
SECURITY DEFINER
AS $$
BEGIN
    UPDATE waitlist.signups
    SET status = p_status, updated_at = now()
    WHERE id = ANY(p_ids);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.update_waitlist_invite(
    p_id uuid,
    p_code text
)
RETURNS void
SECURITY DEFINER
AS $$
BEGIN
    UPDATE waitlist.signups
    SET
        status = 'invited',
        invitation_code = p_code,
        invitation_sent_at = now(),
        updated_at = now()
    WHERE id = p_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.get_waitlist_user(p_id uuid)
RETURNS TABLE(email text, name text)
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY SELECT s.email, s.name FROM waitlist.signups s WHERE s.id = p_id;
END;
$$ LANGUAGE plpgsql;
