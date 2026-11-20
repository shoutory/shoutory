import { z } from "zod";

// The page's content security policy forbids eval. Zod probes for it with `Function("")` when it builds an object
// schema, which the policy refuses and reports even though the probe catches it. This module is imported before any
// module that builds a schema, so the probe never runs.
z.config({ jitless: true });
