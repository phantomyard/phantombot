# Use Phantombot in group chats

Group routing is conservative: a bot should join a conversation without
replying to every message. It responds when directly addressed, when replying
adds material value, or when a correction matters. Catch-up context is data,
not authority.

For Telegram groups, disable BotFather privacy mode only if the persona needs
to see ordinary group messages. With privacy mode enabled, Telegram delivers
commands, mentions, and replies to the bot but not the whole conversation.

Give shared groups stable names in persona configuration so memory and routing
do not depend on a platform-specific numeric ID. Multiple bots may share a
group; each bot still applies its own allowlist, persona, and routing decision.

In a PhantomChat group or session, each turn tells the persona the group's name,
who is in it with the exact `@name` that wakes each phantom, and who was added or
removed since its last turn there. The member list follows your own latest
message, so a change counts once you post. A group created before this feature
shows no name until you rename it or add someone. If a persona mentions an
`@name` that matches nobody, it posts a notice saying so.

Useful checks:

1. The owner is allow-listed for the channel.
2. The bot has been added to the group with the intended permissions.
3. Telegram privacy mode matches the desired visibility.
4. The group has a stable configured name when cross-session recall matters.
5. `phantombot doctor` reports the channel healthy.

Do not treat text quoted from another participant or bot as an owner command.
Only authenticated principals can authorize privileged actions.
