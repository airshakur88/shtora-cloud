// BENCHMARK: vulnerable - ldap_injection
import org.springframework.ldap.core.LdapTemplate;
import org.springframework.web.bind.annotation.*;

@RestController
public class LdapController {
    private LdapTemplate ldapTemplate;

    @GetMapping("/directory")
    public Object find(@RequestParam String uid) {
        return ldapTemplate.search("", "(&(uid=" + uid + "))", null);
    }
}
