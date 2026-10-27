use crate::{SqliteConnectOptions, SqliteConnection};
use log::LevelFilter;
use sqlx_core::config;
use sqlx_core::connection::ConnectOptions;
use sqlx_core::error::Error;
use sqlx_core::executor::Executor;
use sqlx_core::sql_str::AssertSqlSafe;
use std::fmt::Write;
use std::str::FromStr;
use std::time::Duration;
use url::Url;

impl ConnectOptions for SqliteConnectOptions {
    type Connection = SqliteConnection;

    fn from_url(url: &Url) -> Result<Self, Error> {
        // SQLite URL parsing is handled specially;
        // we want to treat the following URLs as equivalent:
        //
        // * sqlite:foo.db
        // * sqlite://foo.db
        //
        // If we used `Url::path()`, the latter would return an empty string
        // because `foo.db` gets parsed as the hostname.
        Self::from_str(url.as_str())
    }

    fn to_url_lossy(&self) -> Url {
        self.build_url()
    }

    async fn connect(&self) -> Result<Self::Connection, Error>
    where
        Self::Connection: Sized,
    {
        let mut conn = SqliteConnection::establish(self).await?;

        conn.configure(self).await?;

        Ok(conn)
    }

    fn log_statements(mut self, level: LevelFilter) -> Self {
        self.log_settings.log_statements(level);
        self
    }

    fn log_slow_statements(mut self, level: LevelFilter, duration: Duration) -> Self {
        self.log_settings.log_slow_statements(level, duration);
        self
    }

    fn __unstable_apply_driver_config(
        self,
        config: &config::drivers::Config,
    ) -> crate::Result<Self> {
        self.apply_driver_config(&config.sqlite)
    }
}

impl SqliteConnectOptions {
    /// Collect all `PRAMGA` commands into a single string
    pub(crate) fn pragma_string(&self) -> String {
        let mut string = String::new();

        for (key, opt_value) in &self.pragmas {
            if let Some(value) = opt_value {
                write!(string, "PRAGMA {key} = {value}; ").ok();
            }
        }

        string
    }
}

impl SqliteConnection {
    /// Configure a connection already retained by its actual owner. If this
    /// fails, the caller still owns the connection and must await real close.
    /// This is the same configuration used by `ConnectOptions::connect`.
    pub async fn configure(&mut self, options: &SqliteConnectOptions) -> Result<(), Error> {
        {
            let mut locked = self.lock_handle().await?;
            locked.guard.handle.call_with_result(|handle| {
                // SAFETY: the locked original connection excludes worker access.
                // This option takes an int and an optional output pointer; no
                // pointer or borrowed SQLite state escapes configuration.
                unsafe {
                    libsqlite3_sys::sqlite3_db_config(
                        handle,
                        libsqlite3_sys::SQLITE_DBCONFIG_ENABLE_QPSG,
                        i32::from(options.query_planner_stability),
                        std::ptr::null_mut::<std::ffi::c_int>(),
                    )
                }
            })?;
        }
        // Execute PRAGMAs
        self.execute(AssertSqlSafe(options.pragma_string())).await?;

        if !options.collations.is_empty() {
            let mut locked = self.lock_handle().await?;

            for collation in &options.collations {
                collation.create(&mut locked.guard.handle)?;
            }
        }

        Ok(())
    }
}
