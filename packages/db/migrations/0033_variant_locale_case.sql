-- Stored language tags take the case RFC 5646 section 2.1.1 gives (https://www.rfc-editor.org/rfc/rfc5646#section-2.1.1,
-- read 2026-11-24): the language and everything after a singleton lower, a 4-letter script title case, a 2-letter
-- region upper. The app stores this case from now on. Two tags of one channel that differ only in case break the
-- target key and fail this migration; that post needs a person, so the error is not caught. A stored tag that is not
-- well formed fails it too, since the app would refuse it on the next save.
CREATE POLICY locale_case_rewrite ON app.post_variants FOR ALL TO shoutory_owner USING (true) WITH CHECK (true);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM app.post_variants WHERE locale !~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$') THEN
    RAISE EXCEPTION 'a stored language tag is not well formed; correct that variant before this migration'
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;
WITH subtags AS (
  SELECT v.id, s.n, CASE
      WHEN s.n = 1 OR coalesce(bool_or(length(s.tag) = 1) OVER (PARTITION BY v.id ORDER BY s.n
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), false) THEN lower(s.tag)
      WHEN s.tag ~ '^[A-Za-z]{2}$' THEN upper(s.tag)
      WHEN s.tag ~ '^[A-Za-z]{4}$' THEN initcap(s.tag)
      ELSE lower(s.tag)
    END AS tag
  FROM app.post_variants AS v, regexp_split_to_table(v.locale, '-') WITH ORDINALITY AS s (tag, n)
  WHERE v.locale IS NOT NULL
), canonical AS (
  SELECT id, string_agg(tag, '-' ORDER BY n) AS locale FROM subtags GROUP BY id
)
UPDATE app.post_variants AS v SET locale = c.locale
FROM canonical AS c
WHERE v.id = c.id AND v.locale IS DISTINCT FROM c.locale;
DROP POLICY locale_case_rewrite ON app.post_variants;
