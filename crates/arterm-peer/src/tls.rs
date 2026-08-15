//! Mutual TLS where the fingerprint is the authentication.
//!
//! Both configurations here replace rustls' certificate verifier. That is the
//! dangerous-sounding part and it is the point: device certificates are
//! self-signed, so the stock verifier has nothing to chain to. Left in place it
//! would reject every legitimate peer; swapped for something permissive it
//! would accept every machine on the network. What replaces it compares the
//! SHA-256 of the presented certificate against the trust store — the same
//! value the two devices exchanged when they paired.
//!
//! What is *not* replaced is signature verification. Both verifiers delegate
//! `verify_tls12_signature` and `verify_tls13_signature` to rustls' own
//! implementations, so the peer still has to prove it holds the private key for
//! the certificate it presented. Skipping that would reduce the whole scheme to
//! "replay a certificate you saw once", and a certificate is public by
//! construction.

use anyhow::{Context, Result};
use arterm_device::DeviceIdentity;
use arterm_device::identity::Fingerprint;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::{
    ClientConfig, DigitallySignedStruct, DistinguishedName, Error as TlsError, ServerConfig,
    SignatureScheme,
};
use std::sync::{Arc, OnceLock};

use crate::gate::{Admission, TrustGate};

/// This device's certificate and key, in the form rustls wants them.
#[derive(Debug)]
pub struct PeerCredentials {
    chain: Vec<CertificateDer<'static>>,
    key: PrivateKeyDer<'static>,
    fingerprint: Fingerprint,
    name: String,
}

impl PeerCredentials {
    pub fn from_identity(identity: &DeviceIdentity) -> Result<Self> {
        let certificate = CertificateDer::from_pem_slice(identity.certificate_pem().as_bytes())
            .map_err(|error| {
                anyhow::anyhow!("this device's certificate is not readable as PEM: {error}")
            })?;
        let key = PrivateKeyDer::from_pem_slice(identity.private_key_pem().as_bytes()).map_err(
            |error| anyhow::anyhow!("this device's private key is not readable as PEM: {error}"),
        )?;
        Ok(Self {
            chain: vec![certificate],
            key,
            fingerprint: identity.fingerprint(),
            name: identity.name().to_string(),
        })
    }

    pub fn fingerprint(&self) -> &Fingerprint {
        &self.fingerprint
    }

    pub fn name(&self) -> &str {
        &self.name
    }
}

/// The crypto provider both ends use.
///
/// Built once and named explicitly rather than read from rustls' process-wide
/// default: this process also runs `reqwest` and a WebSocket client, and
/// depending on whichever of them installed a default first would make the peer
/// transport's behaviour depend on startup order.
fn provider() -> Arc<CryptoProvider> {
    static PROVIDER: OnceLock<Arc<CryptoProvider>> = OnceLock::new();
    Arc::clone(PROVIDER.get_or_init(|| Arc::new(rustls::crypto::aws_lc_rs::default_provider())))
}

/// Server side: present this device's certificate, demand one back, and admit
/// it only if [`TrustGate`] says so.
pub fn server_config(credentials: &PeerCredentials, gate: TrustGate) -> Result<ServerConfig> {
    let provider = provider();
    let verifier = Arc::new(PairedClientVerifier {
        gate,
        provider: Arc::clone(&provider),
    });
    ServerConfig::builder_with_provider(Arc::clone(&provider))
        .with_safe_default_protocol_versions()
        .context("selecting TLS versions for the peer listener")?
        .with_client_cert_verifier(verifier)
        .with_single_cert(credentials.chain.clone(), credentials.key.clone_key())
        .context("installing this device's certificate on the peer listener")
}

/// Client side: present this device's certificate, and accept exactly one
/// fingerprint back.
pub fn client_config(credentials: &PeerCredentials, expected: Fingerprint) -> Result<ClientConfig> {
    let provider = provider();
    let verifier = Arc::new(PinnedServerVerifier {
        expected,
        provider: Arc::clone(&provider),
    });
    ClientConfig::builder_with_provider(Arc::clone(&provider))
        .with_safe_default_protocol_versions()
        .context("selecting TLS versions for the peer connection")?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_client_auth_cert(credentials.chain.clone(), credentials.key.clone_key())
        .context("installing this device's certificate on the peer connection")
}

/// Accepts a client certificate whose fingerprint the trust store knows, or one
/// arriving while an invite is open.
#[derive(Debug)]
struct PairedClientVerifier {
    gate: TrustGate,
    provider: Arc<CryptoProvider>,
}

impl ClientCertVerifier for PairedClientVerifier {
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        // No certificate authorities exist in this scheme, so there is nothing
        // to hint. An empty list tells the client to send whatever it has,
        // which is the one certificate it owns.
        &[]
    }

    fn client_auth_mandatory(&self) -> bool {
        // A connection with no client certificate has nothing to check against
        // the trust store, so it cannot be authenticated at all. Refusing it in
        // the handshake is better than admitting it and discovering later that
        // there is nobody to identify.
        true
    }

    fn verify_client_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _now: UnixTime,
    ) -> Result<ClientCertVerified, TlsError> {
        // Certificate expiry is deliberately not checked. The fingerprint is
        // the identity, and a pairing that stopped working on a date nobody
        // chose would look like a network fault rather than an expiry.
        let fingerprint = Fingerprint::of_certificate(end_entity.as_ref());
        match self.gate.admits(&fingerprint) {
            Ok(Admission::Trusted(_)) | Ok(Admission::PairingWindow) => {
                Ok(ClientCertVerified::assertion())
            }
            Ok(Admission::Refused) => Err(TlsError::General(format!(
                "device {fingerprint} is not paired with this one"
            ))),
            Err(error) => Err(TlsError::General(format!(
                "could not read this device's trust state: {error}"
            ))),
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// Accepts exactly one server fingerprint: the device this connection was
/// asked to reach.
#[derive(Debug)]
struct PinnedServerVerifier {
    expected: Fingerprint,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for PinnedServerVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        // The hostname is not checked, and should not be: peers are reached at
        // whatever address they happen to hold today, and the certificate names
        // the machine, not the address. The fingerprint is what pins the
        // identity, and it does so regardless of where the machine moved to.
        let presented = Fingerprint::of_certificate(end_entity.as_ref());
        if presented == self.expected {
            return Ok(ServerCertVerified::assertion());
        }
        Err(TlsError::General(format!(
            "expected device {} at this address but found {presented} — refusing rather than \
             trusting whoever answered",
            self.expected
        )))
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// The fingerprint of the certificate the far end presented.
///
/// Read from the finished connection rather than recorded by the verifier: a
/// verifier is shared by every connection the listener handles, so anything it
/// stored about "the last peer" would be a race between two devices connecting
/// at once.
pub fn peer_fingerprint(certificates: Option<&[CertificateDer<'static>]>) -> Result<Fingerprint> {
    let presented = certificates
        .and_then(|chain| chain.first())
        .context("the peer completed a handshake without presenting a certificate")?;
    Ok(Fingerprint::of_certificate(presented.as_ref()))
}

#[cfg(test)]
#[path = "tls_tests.rs"]
mod tls_tests;
