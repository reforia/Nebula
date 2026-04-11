#[cfg(test)]
mod tests {
    use crate::{config_path, load_config, save_config, AgentConfig, AgentState};

    #[test]
    fn test_default_agent_state() {
        let state = AgentState::default();
        assert_eq!(state.status, "disconnected");
        assert!(state.server.is_empty());
        assert!(state.agent_id.is_empty());
        assert!(state.error.is_empty());
        assert!(!state.device.is_empty()); // should have os/arch
    }

    #[test]
    fn test_default_agent_config() {
        let config = AgentConfig::default();
        assert!(config.server.is_empty());
        assert!(config.agent_id.is_empty());
        assert!(config.token.is_empty());
    }

    #[test]
    fn test_config_path_exists() {
        let path = config_path();
        assert!(path.to_str().unwrap().contains("nebula-agent"));
        assert!(path.to_str().unwrap().ends_with("config.json"));
    }

    #[test]
    fn test_save_and_load_config() {
        let config = AgentConfig {
            server: "http://test:8090".into(),
            agent_id: "test-id-123".into(),
            token: "secret-token".into(),
            proxy: String::new(),
        };
        save_config(&config);
        let loaded = load_config();
        assert_eq!(loaded.server, "http://test:8090");
        assert_eq!(loaded.agent_id, "test-id-123");
        assert_eq!(loaded.token, "secret-token");

        // Cleanup
        std::fs::remove_file(config_path()).ok();
    }

    #[test]
    fn test_load_missing_config() {
        let path = config_path();
        std::fs::remove_file(&path).ok();
        let config = load_config();
        assert!(config.server.is_empty());
    }

    #[test]
    fn test_agent_state_serialization() {
        let state = AgentState {
            status: "connected".into(),
            server: "http://nas:8090".into(),
            agent_id: "abc-123".into(),
            agent_name: "TestBot".into(),
            error: String::new(),
            device: "darwin/arm64".into(),
            last_activity: "12345".into(),
        };
        let json = serde_json::to_string(&state).unwrap();
        assert!(json.contains("connected"));
        assert!(json.contains("TestBot"));

        let deserialized: AgentState = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.status, "connected");
        assert_eq!(deserialized.agent_name, "TestBot");
    }

    #[test]
    fn test_agent_config_serialization() {
        let config = AgentConfig {
            server: "http://nas:8090".into(),
            agent_id: "id-1".into(),
            token: "tok-1".into(),
            proxy: String::new(),
        };
        let json = serde_json::to_string(&config).unwrap();
        let deserialized: AgentConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.server, config.server);
        assert_eq!(deserialized.token, config.token);
    }
}
