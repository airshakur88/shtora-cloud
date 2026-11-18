// BENCHMARK: vulnerable - xpath_injection
import javax.xml.xpath.*;
import org.springframework.web.bind.annotation.*;
import org.w3c.dom.Document;

@RestController
public class DirectoryController {
    private Document directory;

    @GetMapping("/lookup")
    public String lookup(@RequestParam String username) throws Exception {
        XPath xpath = XPathFactory.newInstance().newXPath();
        return xpath.evaluate("//user[name='" + username + "']", directory);
    }
}
