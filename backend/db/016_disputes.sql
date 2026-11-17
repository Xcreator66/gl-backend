-- Disputes: a household or collector contests a VERIFIED collection. An upheld dispute can only REDUCE or leave rewards unchanged;
-- it can never create GREEN (new credit needs the recycler's independent weight).
CREATE SEQUENCE gl_d_seq START 100001;
CREATE TABLE disputes (
  id bigserial PRIMARY KEY, public_id text UNIQUE NOT NULL, collection_id uuid NOT NULL REFERENCES collections, raised_by uuid NOT NULL REFERENCES users,
  raiser_role text NOT NULL CHECK (raiser_role IN ('household','collector')),
  reason text NOT NULL CHECK (reason IN ('weight_wrong','material_wrong','not_collected','other')), detail text CHECK (char_length(detail)<=300),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','upheld','rejected','withdrawn')),
  resolution_note text, resolved_by uuid REFERENCES users, resolved_at timestamptz, created_at timestamptz DEFAULT now());
CREATE UNIQUE INDEX disputes_one_open ON disputes(collection_id) WHERE state='open';
