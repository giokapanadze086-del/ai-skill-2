// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title BTU AI Skills Digital Passport registry
/// @notice Registers the SHA-256 hash of every officially issued passport version PDF.
///         No personal data is stored on-chain: only the document hash, a hashed
///         passport reference and the version number.
/// @dev Issuer authenticity: only the BTU issuer address can write. BTU publishes this
///      contract address and its issuer address at https://btu.edu.ge/.well-known/did.json
///      (did:web:btu.edu.ge), so any verifier can check that a record was written by BTU.
contract PassportRegistry {
    string public constant ISSUER_NAME = "Business and Technology University (BTU)";
    string public constant ISSUER_DID = "did:web:btu.edu.ge";

    address public issuer;

    struct Version {
        bytes32 passportRef; // keccak256(Passport ID), not the ID itself
        uint32 version;      // V1, V2, ...
        uint64 issuedAt;
        bool exists;
    }

    /// document hash (SHA-256 of the PDF) => version record
    mapping(bytes32 => Version) private documents;
    /// passport reference => latest version number
    mapping(bytes32 => uint32) public latestVersion;

    event PassportVersionIssued(bytes32 indexed docHash, bytes32 indexed passportRef, uint32 version, uint64 issuedAt);
    event IssuerTransferred(address indexed previousIssuer, address indexed newIssuer);

    modifier onlyIssuer() {
        require(msg.sender == issuer, "Only BTU can issue");
        _;
    }

    constructor() {
        issuer = msg.sender;
        emit IssuerTransferred(address(0), msg.sender);
    }

    /// @notice Register a newly issued passport version. Versions must increase by one.
    function issue(bytes32 docHash, bytes32 passportRef, uint32 version) external onlyIssuer {
        require(!documents[docHash].exists, "Document already registered");
        require(version == latestVersion[passportRef] + 1, "Version must follow the latest one");
        documents[docHash] = Version(passportRef, version, uint64(block.timestamp), true);
        latestVersion[passportRef] = version;
        emit PassportVersionIssued(docHash, passportRef, version, uint64(block.timestamp));
    }

    /// @notice Public verification, free to call (view), no account needed.
    /// @return issued   the document hash was registered by BTU
    /// @return isLatest the document is the latest version of its passport
    function verify(bytes32 docHash)
        external
        view
        returns (bool issued, bool isLatest, bytes32 passportRef, uint32 version, uint64 issuedAt, address issuedBy)
    {
        Version memory v = documents[docHash];
        if (!v.exists) return (false, false, bytes32(0), 0, 0, address(0));
        return (true, latestVersion[v.passportRef] == v.version, v.passportRef, v.version, v.issuedAt, issuer);
    }

    function transferIssuer(address newIssuer) external onlyIssuer {
        require(newIssuer != address(0), "Zero address");
        emit IssuerTransferred(issuer, newIssuer);
        issuer = newIssuer;
    }
}
