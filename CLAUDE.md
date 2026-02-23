
**Planning**
If the branch is not clean at the start of a session ask if you should make the changes in the dirty environment or on a new branch


If you need information about gremlin endpoints you can fetch the swagger via:
```shell
curl 'https://api.gremlin.com/v1/openapi.json' | jq '.paths."/reliability-tests/{reliabilityTestId}/runs".post'
```
Or something similar

NOTE: The swagger endpoints are *not* prefixed with `v1/` but the actual endpoints will be

Finally, do *NOT* load the entire openapi.json into your context window it's way too big

**Tooling**
 * Prefer build actions from the Makefile


**Testing**
 * the general test command is: `env $(cat .env | xargs) make test 2>&1`
