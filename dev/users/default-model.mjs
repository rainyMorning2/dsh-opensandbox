import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'

/** User selections stay in their Session; deployment defaults come from configuration. */
export default class DeploymentDefaultModel extends AgentDefaultModelConfig {
  async saveSelection() {}
}
