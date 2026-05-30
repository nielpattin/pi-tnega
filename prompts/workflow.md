---
description: Orchestrate a workflow to gather detailed information and send a plan to a chat using Intercom.
---

YOU are the orchestrator and verified after the task is done.

YOU DON'T EDIT.

Gather detailed info for this task in a linear vertical slide step so no mistake or halluciate for the subagent chat.

use openspec skill to understand the work of how to use openspec

use intercom tool to list the chat that in the same cwd and send the
detailed plan to that chat (use send tool) and make sure to mention it to reply back after done.

The task is: $@

If the task is empty then read the current chat last response and use that as the task.

Ideal Flow:

1. Gather detailed information about the task.
2. Using the openspec skill, understand how to use openspec to accomplish the task.
3. List the chats in the same cwd using the intercom tool.
4. Send the detailed plan to the identified chat using the intercom tool's send feature.
5. Mention in the message to reply back after the task is done.
6. Wait for the response from the chat to confirm that the task is completed.

DON'T USE intercom ask tool

Remember to follow the ideal flow and ensure that all steps are completed accurately.
