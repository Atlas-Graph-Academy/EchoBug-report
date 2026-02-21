-- Add invitation columns if they do not exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'waitlist'
          AND table_name = 'signups'
          AND column_name = 'invitation_code'
    ) THEN
        ALTER TABLE waitlist.signups ADD COLUMN invitation_code text;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'waitlist'
          AND table_name = 'signups'
          AND column_name = 'invitation_sent_at'
    ) THEN
        ALTER TABLE waitlist.signups ADD COLUMN invitation_sent_at timestamptz;
    END IF;
END $$;
