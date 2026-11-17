-- v0.33.0 foundation: verified organisations, membership, campaigns, volunteering and non-cash sponsorship records.
-- This schema never moves GREEN or initiates a payment.

CREATE SEQUENCE IF NOT EXISTS gl_org_seq START 1001;

CREATE TABLE organisations (
  id bigserial PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 3 AND 100),
  organisation_type text NOT NULL CHECK (organisation_type IN ('ngo','school','college','university','society','business','csr','environmental_partner')),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 1200),
  website text,
  email text,
  phone text,
  city text NOT NULL CHECK (char_length(city) BETWEEN 2 AND 80),
  state text NOT NULL CHECK (char_length(state) BETWEEN 2 AND 80),
  country text NOT NULL DEFAULT 'India',
  verification_status text NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending','verified','rejected','suspended')),
  join_policy text NOT NULL DEFAULT 'request' CHECK (join_policy IN ('request','closed')),
  created_by uuid NOT NULL REFERENCES users(id),
  verified_by uuid REFERENCES users(id),
  verification_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX organisations_public ON organisations(verification_status,organisation_type,city,state);

CREATE TABLE organisation_members (
  organisation_id bigint NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  member_role text NOT NULL DEFAULT 'member' CHECK (member_role IN ('owner','admin','manager','member')),
  membership_status text NOT NULL DEFAULT 'pending' CHECK (membership_status IN ('pending','active','rejected','removed')),
  invited_by uuid REFERENCES users(id),
  joined_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organisation_id,user_id)
);
CREATE INDEX organisation_members_user ON organisation_members(user_id,membership_status);

CREATE TABLE campaigns (
  id bigserial PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  organisation_id bigint NOT NULL REFERENCES organisations(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  description text NOT NULL CHECK (char_length(description) BETWEEN 10 AND 2000),
  campaign_type text NOT NULL CHECK (campaign_type IN ('recycling','plantation','cleanliness','awareness','education','volunteering','other')),
  location_text text NOT NULL CHECK (char_length(location_text) BETWEEN 2 AND 160),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  target_grams bigint CHECK (target_grams IS NULL OR target_grams > 0),
  capacity int CHECK (capacity IS NULL OR capacity BETWEEN 1 AND 100000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','active','completed','cancelled')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX campaigns_discovery ON campaigns(status,starts_at,ends_at);
CREATE INDEX campaigns_org ON campaigns(organisation_id,created_at DESC);

CREATE TABLE campaign_members (
  campaign_id bigint NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'joined' CHECK (status IN ('joined','cancelled','completed')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(campaign_id,user_id)
);
CREATE INDEX campaign_members_user ON campaign_members(user_id,joined_at DESC);

CREATE TABLE campaign_attendance (
  id bigserial PRIMARY KEY,
  campaign_id bigint NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  activity_date date NOT NULL,
  hours numeric(5,2) NOT NULL CHECK (hours > 0 AND hours <= 16),
  note text NOT NULL CHECK (char_length(note) BETWEEN 5 AND 500),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected')),
  recorded_by uuid NOT NULL REFERENCES users(id),
  verified_by uuid REFERENCES users(id),
  verification_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  FOREIGN KEY(campaign_id,user_id) REFERENCES campaign_members(campaign_id,user_id),
  CHECK (verified_by IS NULL OR verified_by <> user_id),
  UNIQUE(campaign_id,user_id,activity_date)
);
CREATE INDEX campaign_attendance_status ON campaign_attendance(status,created_at DESC);

CREATE TABLE campaign_sponsorships (
  id bigserial PRIMARY KEY,
  campaign_id bigint NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  sponsor_name text NOT NULL CHECK (char_length(sponsor_name) BETWEEN 2 AND 100),
  pledged_amount_minor bigint CHECK (pledged_amount_minor IS NULL OR pledged_amount_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'INR',
  reference_note text,
  status text NOT NULL DEFAULT 'declared' CHECK (status IN ('declared','confirmed','withdrawn')),
  recorded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE events ADD COLUMN IF NOT EXISTS organisation_id bigint REFERENCES organisations(id);
ALTER TABLE events ADD COLUMN IF NOT EXISTS campaign_id bigint REFERENCES campaigns(id);
CREATE INDEX events_organisation ON events(organisation_id,starts_at) WHERE NOT cancelled;

-- No ledger writes, no automatic XP awards, and no public student roster are introduced by this migration.
