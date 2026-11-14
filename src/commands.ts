/**
 * How a command row behaves when it is activated from the blank-query help list.
 *
 * - "input": fill the query and wait for more input (`new`, `search`)
 * - "navigate": fill the query so the command shows its own results (`list`, `ping`)
 * - "run": execute the command immediately (`paste`, `hideall`, `showall`, `front`)
 */
export type CommandKind = "input" | "navigate" | "run"

/** One command declared in plugin.json, plus the labels and help behavior it needs. */
export interface CommandSpec {
  /** Command token Wox matches after the trigger keyword. */
  name: string
  /** Alternate tokens Wox accepts for the same command. */
  aliases: string[]
  /** i18n key for the usage shown as the help row title. */
  usageKey: string
  /** i18n key for the description already declared in plugin.json. */
  descKey: string
  kind: CommandKind
  /** Text appended to the trigger when filling the query; empty for commands that run directly. */
  suffix: string
}

/**
 * Every command the plugin accepts, in the same order as plugin.json's
 * `Commands`. A metadata test keeps both lists in sync, so a new command cannot
 * be added without showing up in the blank-query help.
 */
export const COMMANDS: CommandSpec[] = [
  {
    name: "new",
    aliases: [],
    usageKey: "command_new_usage",
    descKey: "command_new_desc",
    kind: "input",
    suffix: "new "
  },
  {
    name: "list",
    aliases: ["ls"],
    usageKey: "command_list_usage",
    descKey: "command_list_desc",
    kind: "navigate",
    suffix: "list"
  },
  {
    name: "search",
    aliases: ["s"],
    usageKey: "command_search_usage",
    descKey: "command_search_desc",
    kind: "input",
    suffix: "search "
  },
  {
    name: "paste",
    aliases: [],
    usageKey: "command_paste_usage",
    descKey: "command_paste_desc",
    kind: "run",
    suffix: ""
  },
  {
    name: "hideall",
    aliases: [],
    usageKey: "command_hideall_usage",
    descKey: "command_hideall_desc",
    kind: "run",
    suffix: ""
  },
  {
    name: "showall",
    aliases: [],
    usageKey: "command_showall_usage",
    descKey: "command_showall_desc",
    kind: "run",
    suffix: ""
  },
  {
    name: "front",
    aliases: ["bring"],
    usageKey: "command_front_usage",
    descKey: "command_front_desc",
    kind: "run",
    suffix: ""
  },
  {
    name: "stacks",
    aliases: ["stack"],
    usageKey: "command_stacks_usage",
    descKey: "command_stacks_desc",
    kind: "navigate",
    suffix: "stacks"
  },
  {
    name: "ping",
    aliases: [],
    usageKey: "command_ping_usage",
    descKey: "command_ping_desc",
    kind: "navigate",
    suffix: "ping"
  }
]
