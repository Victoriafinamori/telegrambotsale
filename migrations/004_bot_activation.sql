ALTER TABLE merchant_bot_setup ADD COLUMN activation_status text NOT NULL DEFAULT 'pending' CHECK(activation_status IN ('pending','configuring','changes_requested','active'));
ALTER TABLE merchant_bot_setup ADD COLUMN review_note text CHECK(length(review_note)<=500);
ALTER TABLE merchant_bot_setup ADD COLUMN reviewed_at timestamptz;
ALTER TABLE merchant_bot_setup ADD COLUMN activated_at timestamptz;
ALTER TABLE merchant_bot_setup ADD COLUMN activated_by text;
ALTER TABLE merchant_bot_setup ADD COLUMN deployment_reference text CHECK(length(deployment_reference)<=120);
ALTER TABLE merchant_bot_setup ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>0);
ALTER TABLE merchant_bot_setup ADD CONSTRAINT bot_activation_details CHECK((activation_status='active')=(activated_at IS NOT NULL AND activated_by IS NOT NULL AND deployment_reference IS NOT NULL));
CREATE UNIQUE INDEX merchant_bot_setup_deployment_idx ON merchant_bot_setup(deployment_reference) WHERE deployment_reference IS NOT NULL;
