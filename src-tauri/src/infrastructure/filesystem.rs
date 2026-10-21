use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt, OpenOptionsSyncExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, File, OpenOptions},
};
use std::{
    ffi::OsStr,
    io::{self, Read, Write},
    path::{Component, Path},
};

/// Ancla la resolucion en la raiz del volumen (incluidos prefijos Windows) y abre cada componente sin enlaces.
/// Crear un componente nunca autoriza a seguir un enlace que aparezca entre mkdir y open.
pub fn open_directory(path: &Path, create: bool) -> io::Result<Dir> {
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Se requiere una ruta absoluta.",
        ));
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "No se admite traversal.",
        ));
    }
    #[cfg(windows)]
    if let Some(Component::Prefix(prefix)) = path.components().next()
        && !matches!(
            prefix.kind(),
            std::path::Prefix::Disk(_)
                | std::path::Prefix::VerbatimDisk(_)
                | std::path::Prefix::UNC(..)
                | std::path::Prefix::VerbatimUNC(..)
        )
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Prefijo de dispositivo no admitido.",
        ));
    }
    let root = path
        .ancestors()
        .last()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Ruta sin raiz."))?;
    let mut directory = Dir::open_ambient_dir(root, ambient_authority())?;
    for component in path.components() {
        match component {
            Component::Prefix(_) => {}
            Component::RootDir | Component::CurDir => {}
            Component::Normal(name) => {
                directory = match directory.open_dir_nofollow(name) {
                    Ok(next) => next,
                    Err(error) if create && error.kind() == io::ErrorKind::NotFound => {
                        match directory.create_dir(name) {
                            Ok(()) => {}
                            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                            Err(error) => return Err(error),
                        }
                        directory.open_dir_nofollow(name)?
                    }
                    Err(error) => return Err(error),
                };
            }
            Component::ParentDir => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "No se admite traversal.",
                ));
            }
        }
    }
    Ok(directory)
}

/// Abre la entrada final relativa a un padre ya fijado: nofollow y nonblock se aplican en el open real.
pub fn open_regular(directory: &Dir, name: &OsStr) -> io::Result<File> {
    if Path::new(name).components().count() != 1
        || !matches!(
            Path::new(name).components().next(),
            Some(Component::Normal(_))
        )
        || name.to_string_lossy().contains(':')
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Nombre de archivo no admitido.",
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No).nonblock(true);
    let file = directory.open_with(name, &options)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "La entrada no es un archivo regular.",
        ));
    }
    Ok(file)
}

/// Captura bytes del mismo descriptor que se valida; un FIFO nunca espera a que llegue un escritor.
pub fn read_regular(directory: &Dir, name: &OsStr, limit: usize) -> io::Result<Vec<u8>> {
    let file = open_regular(directory, name)?;
    let length = file.metadata()?.len();
    if length == 0 || length > limit as u64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Se requiere un archivo de entre 1 y {limit} bytes."),
        ));
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("El archivo supera {limit} bytes."),
        ));
    }
    Ok(bytes)
}

/// Lee un archivo externo sin resolver de nuevo sus antecesores despues de fijar sus handles.
pub fn read_external(path: &Path, limit: usize) -> io::Result<Vec<u8>> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "Archivo sin directorio padre.")
    })?;
    let directory = open_directory(parent, false)?;
    let name = path.file_name().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "Nombre de archivo invalido.")
    })?;
    read_regular(&directory, name, limit)
}

/// Copia privada no publicada hasta confirmar SQLite; todas las operaciones usan el mismo Dir fijado.
/// Un cierre abrupto puede dejar un huerfano; nunca se recupera eliminando archivos ajenos.
pub struct NewAudio {
    directory: Dir,
    name: String,
    file: File,
    committed: bool,
}
impl NewAudio {
    /// Expone el nombre generado sin permitir cambiar el destino que protege RAII.
    pub fn name(&self) -> &str {
        &self.name
    }
    /// Crea un nombre backend nuevo con exclusividad atomica, sin reutilizar ni sobrescribir entradas existentes.
    pub fn create(directory: &Dir, bytes: &[u8]) -> io::Result<Self> {
        let name = format!("{}.bin", uuid::Uuid::new_v4());
        let mut options = OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .follow(FollowSymlinks::No)
            .nonblock(true);
        let mut owned = Self {
            directory: directory.try_clone()?,
            file: directory.open_with(&name, &options)?,
            name,
            committed: false,
        };
        owned.file.write_all(bytes)?;
        owned.file.sync_all()?;
        Ok(owned)
    }
    /// Transfiere la propiedad al catalogo solo despues de confirmar la transaccion.
    pub fn commit(mut self) {
        self.committed = true;
    }
}
impl Drop for NewAudio {
    fn drop(&mut self) {
        if !self.committed {
            let _ = self.directory.remove_file(&self.name);
        }
    }
}

/// Publica sin reemplazo mediante hard link atomico en el mismo directorio fijado.
/// Si el sistema no admite enlaces duros, falla sin recurrir a exists+rename.
pub fn publish_new(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("Destino sin directorio."))?;
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::other("Destino sin nombre."))?;
    if name.to_string_lossy().contains([':', '\\']) {
        return Err(io::Error::other("Nombre de destino no admitido."));
    }
    let directory = open_directory(parent, false)?;
    let owned = NewAudio::create(&directory, bytes)?;
    directory.hard_link(owned.name(), &directory, name)?;
    // Drop limpia exclusivamente el temporal; el destino ya apunta a los bytes sincronizados.
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::symlink, sync::mpsc, time::Duration};

    #[test]
    fn final_symlink_substituted_after_resolving_parent_is_never_followed() {
        let temp = crate::test_support::tempdir().unwrap();
        let parent = temp.path().join("parent");
        fs::create_dir(&parent).unwrap();
        let outside = temp.path().join("outside");
        fs::write(&outside, b"ajeno").unwrap();
        fs::write(parent.join("sound"), b"propio").unwrap();
        let anchored = open_directory(&parent, false).unwrap();
        fs::remove_file(parent.join("sound")).unwrap();
        symlink(&outside, parent.join("sound")).unwrap();
        assert!(read_regular(&anchored, "sound".as_ref(), 32).is_err());
        assert_eq!(fs::read(outside).unwrap(), b"ajeno");
    }

    #[test]
    fn parent_substitution_cannot_redirect_a_pinned_read_or_new_managed_copy() {
        let temp = crate::test_support::tempdir().unwrap();
        let parent = temp.path().join("parent");
        fs::create_dir(&parent).unwrap();
        let outside = temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(parent.join("sound"), b"propio").unwrap();
        fs::write(outside.join("sound"), b"ajeno").unwrap();
        let anchored = open_directory(&parent, false).unwrap();
        let original = temp.path().join("original");
        fs::rename(&parent, &original).unwrap();
        symlink(&outside, &parent).unwrap();
        assert_eq!(
            read_regular(&anchored, "sound".as_ref(), 32).unwrap(),
            b"propio"
        );
        assert!(read_external(&parent.join("sound"), 32).is_err());
        let owned = NewAudio::create(&anchored, b"capturado").unwrap();
        let name = owned.name.clone();
        owned.commit();
        assert_eq!(fs::read(original.join(&name)).unwrap(), b"capturado");
        assert!(!outside.join(name).exists());
    }

    #[test]
    fn component_replaced_before_next_open_is_rejected_and_cleanup_uses_its_original_dir() {
        let temp = crate::test_support::tempdir().unwrap();
        let root = open_directory(temp.path(), false).unwrap();
        fs::create_dir(temp.path().join("audio")).unwrap();
        fs::create_dir(temp.path().join("outside")).unwrap();
        let audio = root.open_dir_nofollow("audio").unwrap();
        let owned = NewAudio::create(&audio, b"parcial").unwrap();
        let name = owned.name.clone();
        fs::rename(temp.path().join("audio"), temp.path().join("original")).unwrap();
        symlink(temp.path().join("outside"), temp.path().join("audio")).unwrap();
        fs::write(temp.path().join("outside").join(&name), b"ajeno").unwrap();
        assert!(root.open_dir_nofollow("audio").is_err());
        drop(owned);
        assert!(!temp.path().join("original").join(&name).exists());
        assert_eq!(
            fs::read(temp.path().join("outside").join(name)).unwrap(),
            b"ajeno"
        );
    }

    #[test]
    fn fifo_substituted_after_resolving_parent_is_rejected_without_waiting_for_a_writer() {
        let temp = crate::test_support::tempdir().unwrap();
        let anchored = open_directory(temp.path(), false).unwrap();
        let path = temp.path().join("fifo");
        assert!(
            std::process::Command::new("mkfifo")
                .arg(path)
                .status()
                .unwrap()
                .success()
        );
        let (send, receive) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            send.send(read_regular(&anchored, "fifo".as_ref(), 32))
                .unwrap()
        });
        assert!(
            receive
                .recv_timeout(Duration::from_secs(2))
                .expect("La apertura de FIFO no debe bloquear")
                .is_err()
        );
        reader.join().unwrap();
    }
}
