//! Directorios privados y exclusivos para pruebas; no forma parte del binario de produccion.
use std::{
    fs::{self, DirBuilder},
    io,
    path::{Path, PathBuf},
};

/// Posee unicamente el directorio UUID creado por este modulo y limpia su contenido al finalizar.
pub(crate) struct TempDir {
    path: PathBuf,
}

impl TempDir {
    /// Devuelve la raiz privada sin transferir su propiedad ni aceptar destinos externos.
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

/// Crea atomicamente un directorio UUID bajo la raiz temporal del sistema, sin reutilizar entradas.
pub(crate) fn tempdir() -> io::Result<TempDir> {
    create_under(&std::env::temp_dir())
}

/// Resuelve el padre existente antes de crear la raiz UUID; admite alias temporales del sistema.
fn create_under(parent: &Path) -> io::Result<TempDir> {
    let parent = fs::canonicalize(parent)?;
    let mut builder = DirBuilder::new();
    builder.recursive(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    for _ in 0..8 {
        let path = parent.join(format!("radiofx-test-{}", uuid::Uuid::new_v4()));
        match builder.create(&path) {
            Ok(()) => return Ok(TempDir { path }),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "No se pudo reservar un directorio temporal exclusivo.",
    ))
}

impl Drop for TempDir {
    fn drop(&mut self) {
        // remove_dir_all de std no sigue enlaces, tampoco si se sustituyo la raiz por uno.
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn directories_have_unique_uuid_names_and_never_reuse_existing_contents() {
        let mut names = HashSet::new();
        let mut directories = Vec::new();
        for _ in 0..16 {
            let directory = tempdir().unwrap();
            assert_eq!(
                directory.path().parent(),
                Some(fs::canonicalize(std::env::temp_dir()).unwrap().as_path())
            );
            let name = directory.path().file_name().unwrap().to_str().unwrap();
            let id = uuid::Uuid::parse_str(name.strip_prefix("radiofx-test-").unwrap()).unwrap();
            assert_eq!(id.get_version_num(), 4);
            assert!(names.insert(directory.path().to_path_buf()));
            fs::write(directory.path().join("owned"), name).unwrap();
            assert_eq!(
                DirBuilder::new()
                    .create(directory.path())
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::AlreadyExists
            );
            directories.push(directory);
        }
        for directory in directories {
            assert_eq!(
                fs::read_to_string(directory.path().join("owned")).unwrap(),
                directory.path().file_name().unwrap().to_str().unwrap()
            );
        }
    }

    #[test]
    fn dropping_directory_cleans_nested_contents_and_missing_root_is_harmless() {
        let directory = tempdir().unwrap();
        let path = directory.path().to_path_buf();
        fs::create_dir_all(path.join("nested/deep")).unwrap();
        fs::write(path.join("nested/deep/owned"), b"propio").unwrap();
        drop(directory);
        assert!(!path.exists());
        let directory = tempdir().unwrap();
        fs::remove_dir(directory.path()).unwrap();
        drop(directory);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_parent_creates_canonical_root_and_cleanup_preserves_alias() {
        use std::os::unix::fs::symlink;
        let owner = tempdir().unwrap();
        let target = owner.path().join("target");
        let alias = owner.path().join("alias");
        fs::create_dir(&target).unwrap();
        symlink(&target, &alias).unwrap();

        let directory = create_under(&alias).unwrap();
        let path = directory.path().to_path_buf();
        assert_eq!(path.parent(), Some(target.as_path()));
        assert_eq!(fs::canonicalize(&path).unwrap(), path);
        fs::write(path.join("owned"), b"propio").unwrap();
        drop(directory);

        assert!(!path.exists());
        assert_eq!(fs::read_link(&alias).unwrap(), target);
        assert_eq!(fs::read_dir(&target).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn directories_are_private_from_creation() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempdir().unwrap();
        assert_eq!(
            fs::metadata(directory.path()).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_does_not_follow_nested_links_or_parent_traversal_targets() {
        use std::os::unix::fs::symlink;
        let directory = tempdir().unwrap();
        let other = tempdir().unwrap();
        fs::write(other.path().join("keep"), b"conservar").unwrap();
        let relative = Path::new("..").join(other.path().file_name().unwrap());
        symlink(relative, directory.path().join("link")).unwrap();
        drop(directory);
        assert_eq!(fs::read(other.path().join("keep")).unwrap(), b"conservar");
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_does_not_follow_a_replaced_root_symlink() {
        use std::os::unix::fs::symlink;
        let directory = tempdir().unwrap();
        let path = directory.path().to_path_buf();
        let other = tempdir().unwrap();
        fs::write(other.path().join("keep"), b"conservar").unwrap();
        fs::remove_dir(&path).unwrap();
        symlink(other.path(), &path).unwrap();
        drop(directory);
        assert!(fs::symlink_metadata(path).is_err());
        assert_eq!(fs::read(other.path().join("keep")).unwrap(), b"conservar");
    }
}
