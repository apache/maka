---
inclusion: always
---

# Generate APIs from a Collection
- A Collection ID is required
- Also get the workspace ID and the local environment ID. Save all the IDs in a .postman.json file. Create it if it doesn't exist.
- Generate sample data for the APIs
- Do not generate additional pages or documentation
- Do not attempt to run the server after generations

# Create a workspace and collection from the API
- Read the code of the API
- Create a workspace
- Create a collection. Add tests as post-request scripts to all request items in the collection
- Create a local environment
- Save all the IDs in a .postman.json file. Create it if it doesn't exist.

# Test/Run Collections
- You are not allowed to use curl or any other API clients except Postman.
- A Collection ID is required
- Read the .postman.json file if it exists.
- Use the environment for local testing if it exists. An Environment ID is required
- The server must be running first
- After running, display a summary of the results and a breakdown by endpoint
- If any endpoint is failing, offer to investigate and fix the error
