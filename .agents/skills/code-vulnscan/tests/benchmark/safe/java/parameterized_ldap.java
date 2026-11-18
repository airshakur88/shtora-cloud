// BENCHMARK: safe - LDAP filter argument parameterization
import org.springframework.ldap.core.LdapTemplate;

public class SafeLdapLookup {
    private LdapTemplate ldapTemplate;

    public Object find(String uid) {
        return ldapTemplate.search("", "(&(uid={0}))", new String[] {uid}, null);
    }
}
